const asyncHandler = require('express-async-handler');
const Admin = require('../models/Admin');
const User = require('../models/User');
const Provider = require('../models/Provider');
const ProviderDocument = require('../models/ProviderDocument');
const ProviderSubmission = require('../models/ProviderSubmission');
const Post = require('../models/Post');
const { generateTokens } = require('../utils/generateToken');
const { sendEmail } = require('../services/emailService');

// @desc    Admin login
// @route   POST /api/admin/login
// @access  Public
const adminLogin = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const admin = await Admin.findOne({ email }).select('+password');

  if (!admin) {
    res.status(401);
    throw new Error('Invalid email or password');
  }

  if (!admin.isActive) {
    res.status(403);
    throw new Error('Your admin account has been deactivated');
  }

  if (admin && (await admin.matchPassword(password))) {
    const tokens = generateTokens(admin._id, {
      userType: 'admin',
      email: admin.email,
      role: admin.role
    });

    admin.refreshToken = tokens.refreshToken;
    admin.lastLoginDate = Date.now();
    admin.logActivity('login', admin._id, 'Admin', 'Admin logged in');
    await admin.save();

    res.json({
      success: true,
      admin: {
        id: admin._id,
        fullName: admin.fullName,
        email: admin.email,
        role: admin.role,
        permissions: admin.permissions,
        isSuperAdmin: admin.isSuperAdmin,
      },
      ...tokens,
    });
  } else {
    res.status(401);
    throw new Error('Invalid email or password');
  }
});

// @desc    Get dashboard statistics
// @route   GET /api/admin/dashboard
// @access  Private/Admin
const getDashboardStats = asyncHandler(async (req, res) => {
  const [
    totalUsers,
    totalProviders,
    pendingProviders,
    approvedProviders,
    rejectedProviders,
    totalPosts,
    activeUsers,
    activeProviders,
  ] = await Promise.all([
    User.countDocuments(),
    Provider.countDocuments(),
    Provider.countDocuments({ verificationStatus: 'pending' }),
    Provider.countDocuments({ verificationStatus: 'approved' }),
    Provider.countDocuments({ verificationStatus: 'rejected' }),
    Post.countDocuments(),
    User.countDocuments({ isActive: true }),
    Provider.countDocuments({ isActive: true, verificationStatus: 'approved' }),
  ]);

  // Get recent users (last 7 days)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentUsers = await User.countDocuments({
    createdAt: { $gte: sevenDaysAgo },
  });

  const recentProviders = await Provider.countDocuments({
    createdAt: { $gte: sevenDaysAgo },
  });

  // Provider type breakdown
  const providersByType = await Provider.aggregate([
    { $match: { verificationStatus: 'approved' } },
    { $group: { _id: '$providerType', count: { $sum: 1 } } },
  ]);

  res.json({
    success: true,
    stats: {
      users: {
        total: totalUsers,
        active: activeUsers,
        recent: recentUsers,
      },
      providers: {
        total: totalProviders,
        pending: pendingProviders,
        approved: approvedProviders,
        rejected: rejectedProviders,
        active: activeProviders,
        recent: recentProviders,
        byType: providersByType,
      },
      posts: {
        total: totalPosts,
      },
    },
  });
});

// @desc    Get pending providers for review
// @route   GET /api/admin/providers/pending
// @access  Private/Admin
const getPendingProviders = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  const total = await Provider.countDocuments({ verificationStatus: 'pending' });

  const providers = await Provider.find({ verificationStatus: 'pending' })
    .select('-password -refreshToken')
    .sort('-createdAt')
    .limit(limit)
    .skip(skip);

  // Fetch documents for each provider
  const providersWithDocs = await Promise.all(
    providers.map(async (provider) => {
      const documents = await ProviderDocument.find({
        providerId: provider._id,
      }).select('-__v');

      return {
        ...provider.toObject(),
        documents: documents.map((doc) => ({
          id: doc._id,
          documentType: doc.documentType,
          fileName: doc.fileName,
          fileUrl: doc.fileUrl,
          fileSize: doc.fileSize,
          uploadedAt: doc.uploadedAt,
          verified: doc.verified,
        })),
      };
    })
  );

  res.json({
    success: true,
    providers: providersWithDocs,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Get provider details for review
// @route   GET /api/admin/providers/:id
// @access  Private/Admin
const getProviderForReview = asyncHandler(async (req, res) => {
  const provider = await Provider.findById(req.params.id);

  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }

  // Fetch all documents for this provider
  const documents = await ProviderDocument.find({
    providerId: provider._id,
  }).select('-__v');

  const providerData = {
    ...provider.toObject(),
    documents: documents.map((doc) => ({
      id: doc._id,
      documentType: doc.documentType,
      fileName: doc.fileName,
      fileUrl: doc.fileUrl,
      fileSize: doc.fileSize,
      mimeType: doc.mimeType,
      uploadedAt: doc.uploadedAt,
      verified: doc.verified,
      verifiedAt: doc.verifiedAt,
      verifiedBy: doc.verifiedBy,
      rejectionReason: doc.rejectionReason,
    })),
  };

  res.json({
    success: true,
    provider: providerData,
  });
});

// @desc    Approve provider
// @route   POST /api/admin/providers/:id/approve
// @access  Private/Admin
// ✅ UPDATED: Issue FULL token when approving (two-phase auth)
const approveProvider = asyncHandler(async (req, res) => {
  const { generateTokens } = require('../utils/generateToken');
  
  const provider = await Provider.findById(req.params.id);

  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }

  if (provider.verificationStatus === 'approved') {
    res.status(400);
    throw new Error('Provider is already approved');
  }

  // Update status to approved (two-phase auth)
  provider.verificationStatus = 'approved';
  provider.onboardingStatus = 'approved'; // Phase 2: Full access
  provider.isVerified = true;
  provider.canLogin = true; // Now can login with full token
  provider.verifiedBy = req.user._id;
  provider.approvedAt = new Date();
  await provider.save();

  // Generate FULL access token for immediate use
  const tokens = generateTokens(provider._id, {
    userType: 'provider',
    email: provider.email,
    tokenType: 'FULL',
    onboardingStatus: provider.onboardingStatus
  });

  // Log admin activity
  req.user.logActivity(
    'approve_provider',
    provider._id,
    'Provider',
    `Approved provider: ${provider.fullName}`
  );
  req.user.incrementStat('totalProvidersApproved');
  await req.user.save();

  // Send approval email
  try {
    await sendEmail({
      email: provider.email,
      subject: 'Your Provider Account Has Been Approved - MetroMatrix',
      html: `
        <h1>Congratulations!</h1>
        <p>Dear ${provider.fullName},</p>
        <p>Your provider account has been approved! You can now start offering your services on MetroMatrix.</p>
        <p>You have been issued a FULL access token. You can use it immediately to access your dashboard and manage your services.</p>
        <p>If you prefer to login, use your email and password on the login page.</p>
        <p>Best regards,<br>MetroMatrix Team</p>
      `,
    });
  } catch (error) {
    console.error('Error sending approval email:', error);
  }

  res.json({
    success: true,
    message: 'Provider approved successfully. FULL access token issued.',
    provider: {
      id: provider._id,
      fullName: provider.fullName,
      email: provider.email,
      onboardingStatus: provider.onboardingStatus,
      verificationStatus: provider.verificationStatus,
    },
    tokens: tokens, // Return FULL token for immediate use
    tokenType: 'FULL', // Indicate this is full access
  });
});

// @desc    Reject provider
// @route   POST /api/admin/providers/:id/reject
// @access  Private/Admin
// ✅ UPDATED: Keep onboarding status as pending_approval so provider can resubmit (two-phase auth)
const rejectProvider = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const provider = await Provider.findById(req.params.id);

  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }

  provider.verificationStatus = 'rejected';
  provider.rejectionReason = reason;
  provider.verifiedBy = req.user._id;
  // Keep onboardingStatus as pending_approval so provider can resubmit with corrections
  await provider.save();

  // Log admin activity
  req.user.logActivity(
    'reject_provider',
    provider._id,
    'Provider',
    `Rejected provider: ${provider.fullName} - Reason: ${reason}`
  );
  req.user.incrementStat('totalProvidersRejected');
  await req.user.save();

  // Send rejection email
  try {
    await sendEmail({
      email: provider.email,
      subject: 'Provider Application Update - MetroMatrix',
      html: `
        <h1>Application Update</h1>
        <p>Dear ${provider.fullName},</p>
        <p>Thank you for submitting your provider application. Unfortunately, it could not be approved at this time.</p>
        <p><strong>Reason:</strong> ${reason}</p>
        <p>Good news! You can resubmit your application with corrections. Simply log in with your LIMITED token or use your credentials to update your information and documents.</p>
        <p>We look forward to reviewing your updated application.</p>
        <p>Best regards,<br>MetroMatrix Team</p>
      `,
    });
  } catch (error) {
    console.error('Error sending rejection email:', error);
  }

  res.json({
    success: true,
    message: 'Provider rejected successfully',
  });
});

// @desc    Get all users
// @route   GET /api/admin/users
// @access  Private/Admin
const getAllUsers = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  const query = {};

  if (req.query.search) {
    query.$or = [
      { fullName: { $regex: req.query.search, $options: 'i' } },
      { email: { $regex: req.query.search, $options: 'i' } },
    ];
  }

  if (req.query.isActive !== undefined) {
    query.isActive = req.query.isActive === 'true';
  }

  const total = await User.countDocuments(query);
  const users = await User.find(query)
    .select('-password -refreshToken')
    .sort('-createdAt')
    .limit(limit)
    .skip(skip);

  res.json({
    success: true,
    users,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Get all providers
// @route   GET /api/admin/providers
// @access  Private/Admin
const getAllProviders = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  const query = {};

  if (req.query.search) {
    query.$or = [
      { fullName: { $regex: req.query.search, $options: 'i' } },
      { email: { $regex: req.query.search, $options: 'i' } },
    ];
  }

  if (req.query.verificationStatus) {
    query.verificationStatus = req.query.verificationStatus;
  }

  if (req.query.providerType) {
    query.providerType = req.query.providerType;
  }

  if (req.query.isActive !== undefined) {
    query.isActive = req.query.isActive === 'true';
  }

  const total = await Provider.countDocuments(query);
  const providers = await Provider.find(query)
    .select('-password -refreshToken')
    .sort('-createdAt')
    .limit(limit)
    .skip(skip);

  res.json({
    success: true,
    providers,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Deactivate user
// @route   PUT /api/admin/users/:id/deactivate
// @access  Private/Admin
const deactivateUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  user.isActive = false;
  await user.save();

  // Log admin activity
  req.user.logActivity(
    'deactivate_user',
    user._id,
    'User',
    `Deactivated user: ${user.fullName}`
  );
  await req.user.save();

  res.json({
    success: true,
    message: 'User deactivated successfully',
  });
});

// @desc    Activate user
// @route   PUT /api/admin/users/:id/activate
// @access  Private/Admin
const activateUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  user.isActive = true;
  await user.save();

  // Log admin activity
  req.user.logActivity(
    'activate_user',
    user._id,
    'User',
    `Activated user: ${user.fullName}`
  );
  await req.user.save();

  res.json({
    success: true,
    message: 'User activated successfully',
  });
});

// @desc    Deactivate provider
// @route   PUT /api/admin/providers/:id/deactivate
// @access  Private/Admin
const deactivateProvider = asyncHandler(async (req, res) => {
  const provider = await Provider.findById(req.params.id);

  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }

  provider.isActive = false;
  await provider.save();

  // Log admin activity
  req.user.logActivity(
    'deactivate_user',
    provider._id,
    'Provider',
    `Deactivated provider: ${provider.fullName}`
  );
  await req.user.save();

  res.json({
    success: true,
    message: 'Provider deactivated successfully',
  });
});

// @desc    Activate provider
// @route   PUT /api/admin/providers/:id/activate
// @access  Private/Admin
const activateProvider = asyncHandler(async (req, res) => {
  const provider = await Provider.findById(req.params.id);

  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }

  provider.isActive = true;
  await provider.save();

  // Log admin activity
  req.user.logActivity(
    'activate_user',
    provider._id,
    'Provider',
    `Activated provider: ${provider.fullName}`
  );
  await req.user.save();

  res.json({
    success: true,
    message: 'Provider activated successfully',
  });
});

// @desc    Delete post
// @route   DELETE /api/admin/posts/:id
// @access  Private/Admin
const deletePost = asyncHandler(async (req, res) => {
  const post = await Post.findById(req.params.id);

  if (!post) {
    res.status(404);
    throw new Error('Post not found');
  }

  await post.deleteOne();

  // Log admin activity
  req.user.logActivity('delete_post', post._id, 'Post', `Deleted post by admin`);
  req.user.incrementStat('totalPostsModerated');
  await req.user.save();

  res.json({
    success: true,
    message: 'Post deleted successfully',
  });
});

// ===== PROVIDER SUBMISSION ENDPOINTS (PUBLIC/NO AUTH) =====

// @desc    Submit provider application (PUBLIC - no auth needed)
// @route   POST /api/admin/provider-submissions
// @access  Public
// @desc    Submit provider documents (after email verification)
// @route   POST /api/admin/provider-submissions
// @access  Public (but requires providerId from verified email)
// ✅ UPDATED: Provider account already exists (created during email verification)
const submitProviderApplication = asyncHandler(async (req, res) => {
  const {
    providerId, // ✅ NEW: Provider ID from email verification
    providerType,
    providerSubType,
    email,
    specialty,
    experience,
    qualification,
    city,
    address,
    idNumber,
    bio,
    services,
    consultationFee,
    serviceFee,
  } = req.body;

  // ✅ Verify provider exists and email is verified
  const provider = await Provider.findOne({ _id: providerId, email });
  
  if (!provider) {
    res.status(404);
    throw new Error('Provider not found. Please verify your email first.');
  }

  if (!provider.emailVerified) {
    res.status(400);
    throw new Error('Please verify your email before submitting documents.');
  }

  // Check if submission already exists for this provider
  const existingSubmission = await ProviderSubmission.findOne({ 
    email,
    status: 'pending_review'
  });

  if (existingSubmission) {
    res.status(400);
    throw new Error('You already have a pending submission. Please wait for admin review.');
  }

  // Process uploaded documents
  const documents = {};
  
  if (req.files) {
    if (req.files.medicalLicense) {
      documents.medicalLicense = {
        url: req.files.medicalLicense[0].path,
        publicId: req.files.medicalLicense[0].filename,
      };
    }
    if (req.files.degreeCertificate) {
      documents.degreeCertificate = {
        url: req.files.degreeCertificate[0].path,
        publicId: req.files.degreeCertificate[0].filename,
      };
    }
    if (req.files.nationalIdCard) {
      documents.nationalIdCard = {
        url: req.files.nationalIdCard[0].path,
        publicId: req.files.nationalIdCard[0].filename,
      };
    }
    if (req.files.profilePhoto) {
      documents.profilePhoto = {
        url: req.files.profilePhoto[0].path,
        publicId: req.files.profilePhoto[0].filename,
      };
    }
    if (req.files.additionalCertificates) {
      documents.additionalCertificates = req.files.additionalCertificates.map(file => ({
        url: file.path,
        publicId: file.filename,
        name: file.originalname,
      }));
    }
  }

  // ✅ Update provider with document submission data
  provider.providerType = providerType || provider.providerType;
  provider.providerSubType = providerSubType || provider.providerSubType;
  provider.specialty = specialty || provider.specialty;
  provider.experience = experience || provider.experience;
  provider.city = city || provider.city;
  provider.idNumber = idNumber || provider.idNumber;
  provider.briefDescription = bio || provider.briefDescription;
  provider.onboardingStatus = 'pending_approval'; // ✅ Documents submitted, awaiting admin
  provider.isVerified = false; // ✅ Still not verified until admin approves
  
  if (address) {
    provider.address = typeof address === 'string' ? JSON.parse(address) : address;
  }
  
  await provider.save();

  // Create submission record
  const submission = await ProviderSubmission.create({
    providerId: provider._id, // ✅ Link to provider account
    providerType,
    providerSubType,
    fullName: provider.fullName,
    email,
    phoneNumber: provider.phoneNumber,
    specialty,
    experience,
    qualification,
    city,
    address,
    idNumber,
    bio,
    services: services ? (Array.isArray(services) ? services : JSON.parse(services)) : [],
    consultationFee,
    serviceFee,
    documents,
    status: 'pending_review',
    submittedAt: new Date(),
  });

  // Send notification email to admins
  try {
    await sendEmail({
      email: process.env.ADMIN_EMAIL || 'admin@metromatrix.com',
      subject: 'New Provider Documents Submitted - Review Required',
      html: `
        <h2>Provider Documents Submitted</h2>
        <p><strong>Name:</strong> ${provider.fullName}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Type:</strong> ${providerType}</p>
        <p><strong>City:</strong> ${city}</p>
        <p><strong>Submission ID:</strong> ${submission._id}</p>
        <p>Please review this provider's documents in the admin dashboard.</p>
      `,
    });
  } catch (error) {
    console.error('Error sending admin notification:', error);
  }

  res.status(201).json({
    success: true,
    message: 'Your documents have been submitted successfully! Please wait for admin approval.',
    submissionId: submission._id,
    providerId: provider._id,
    status: 'pending_review',
    onboardingStatus: 'pending_approval',
  });
});

// @desc    Check submission status by email (PUBLIC - no auth)
// @route   GET /api/admin/provider-submissions/check-status
// @access  Public
const checkSubmissionStatus = asyncHandler(async (req, res) => {
  const { email } = req.query;

  if (!email) {
    res.status(400);
    throw new Error('Email is required');
  }

  // Find most recent submission for this email
  const submission = await ProviderSubmission.findOne({ email })
    .sort({ submittedAt: -1 })
    .select('status submittedAt reviewedAt rejectionReason providerId');

  if (!submission) {
    res.status(404);
    throw new Error('No submission found for this email');
  }

  const response = {
    success: true,
    status: submission.status,
    submissionId: submission._id,
    submittedAt: submission.submittedAt,
  };

  // If approved, fetch provider and generate tokens
  if (submission.status === 'approved' && submission.providerId) {
    const provider = await Provider.findById(submission.providerId);
    
    if (provider) {
      const tokens = generateTokens(provider._id, {
        userType: 'provider',
        email: provider.email,
        tokenType: 'FULL',
        onboardingStatus: 'approved'
      });

      response.tokens = tokens;
      response.provider = {
        id: provider._id,
        fullName: provider.fullName,
        email: provider.email,
        providerType: provider.providerType,
      };
    }
  }

  // If rejected, include rejection reason
  if (submission.status === 'rejected') {
    response.rejectionReason = submission.rejectionReason;
    response.reviewedAt = submission.reviewedAt;
  }

  res.json(response);
});

// @desc    Get all provider submissions (for admin review)
// @route   GET /api/admin/provider-submissions
// @access  Private/Admin
const getProviderSubmissions = asyncHandler(async (req, res) => {
  const { status } = req.query;

  const filter = status ? { status } : {};
  
  const submissions = await ProviderSubmission.find(filter)
    .sort({ submittedAt: -1 })
    .select('-documents.medicalLicense.publicId -documents.degreeCertificate.publicId');

  res.json({
    success: true,
    count: submissions.length,
    submissions,
  });
});

// @desc    Get single provider submission details
// @route   GET /api/admin/provider-submissions/:id
// @access  Private/Admin
const getProviderSubmissionById = asyncHandler(async (req, res) => {
  const submission = await ProviderSubmission.findById(req.params.id);

  if (!submission) {
    res.status(404);
    throw new Error('Submission not found');
  }

  res.json({
    success: true,
    submission,
  });
});

// @desc    Approve provider submission (updates existing Provider)
// @route   POST /api/admin/provider-submissions/:id/approve
// @access  Private/Admin
// ✅ UPDATED: Provider account already exists - just set isVerified=true
const approveProviderSubmission = asyncHandler(async (req, res) => {
  const submission = await ProviderSubmission.findById(req.params.id);

  if (!submission) {
    res.status(404);
    throw new Error('Submission not found');
  }

  if (submission.status !== 'pending_review') {
    res.status(400);
    throw new Error(`Submission already ${submission.status}`);
  }

  // ✅ Get existing provider account (created during email verification)
  const provider = await Provider.findOne({ email: submission.email });
  
  if (!provider) {
    res.status(404);
    throw new Error('Provider account not found. Please contact support.');
  }

  // ✅ Update provider with approval status
  provider.isVerified = true; // ✅ CRITICAL: Enable login
  provider.canLogin = true;
  provider.onboardingStatus = 'approved';
  provider.verificationStatus = 'approved';
  provider.verifiedBy = req.user._id;
  provider.approvedAt = new Date();
  
  // Update profile photo if provided
  if (submission.documents.profilePhoto?.url) {
    provider.profilePhoto = submission.documents.profilePhoto.url;
    provider.profilePhotoId = submission.documents.profilePhoto.publicId;
  }
  
  await provider.save();

  // Create ProviderDocument records for uploaded documents
  const documentPromises = [];
  
  if (submission.documents.medicalLicense) {
    documentPromises.push(
      ProviderDocument.create({
        provider: provider._id,
        documentType: 'medicalLicense',
        documentUrl: submission.documents.medicalLicense.url,
        publicId: submission.documents.medicalLicense.publicId,
        status: 'approved',
        verifiedBy: req.user._id,
        verifiedAt: new Date(),
      })
    );
  }
  
  if (submission.documents.degreeCertificate) {
    documentPromises.push(
      ProviderDocument.create({
        provider: provider._id,
        documentType: 'degreeCertificate',
        documentUrl: submission.documents.degreeCertificate.url,
        publicId: submission.documents.degreeCertificate.publicId,
        status: 'approved',
        verifiedBy: req.user._id,
        verifiedAt: new Date(),
      })
    );
  }
  
  if (submission.documents.nationalIdCard) {
    documentPromises.push(
      ProviderDocument.create({
        provider: provider._id,
        documentType: 'nationalIdCard',
        documentUrl: submission.documents.nationalIdCard.url,
        publicId: submission.documents.nationalIdCard.publicId,
        status: 'approved',
        verifiedBy: req.user._id,
        verifiedAt: new Date(),
      })
    );
  }

  await Promise.all(documentPromises);

  // Update submission status
  submission.status = 'approved';
  submission.providerId = provider._id;
  submission.reviewedAt = new Date();
  submission.reviewedBy = req.user._id;
  await submission.save();

  // Log admin activity
  req.user.logActivity(
    'approve_provider_submission',
    provider._id,
    'Provider',
    `Approved provider submission: ${provider.fullName}`
  );
  req.user.incrementStat('totalProvidersApproved');
  await req.user.save();

  // Send approval email to provider
  try {
    await sendEmail({
      email: provider.email,
      subject: '✅ Your Provider Account Has Been Approved! - MetroMatrix',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #6366f1;">🎉 Congratulations!</h1>
          <p>Dear ${provider.fullName},</p>
          <p>Your provider application has been <strong>approved</strong>! You can now login and start offering your services on MetroMatrix.</p>
          
          <div style="background: #f0f9ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Next Steps:</h3>
            <ol>
              <li>Login to your account using your email and password</li>
              <li>Complete your profile information</li>
              <li>Set your availability schedule</li>
              <li>Start receiving service requests</li>
            </ol>
          </div>
          
          <p><strong>You can now login!</strong> Use your registered email and password to access your account.</p>
          
          <p>If you have any questions, feel free to contact our support team.</p>
          
          <p>Best regards,<br/>The MetroMatrix Team</p>
        </div>
      `,
    });
  } catch (error) {
    console.error('Error sending approval email:', error);
  }

  res.json({
    success: true,
    message: 'Provider application approved successfully. Provider can now login.',
    provider: {
      id: provider._id,
      fullName: provider.fullName,
      email: provider.email,
      providerType: provider.providerType,
      onboardingStatus: provider.onboardingStatus,
      isVerified: provider.isVerified,
      canLogin: provider.canLogin,
    },
  });
});

// @desc    Reject provider submission
// @route   POST /api/admin/provider-submissions/:id/reject
// @access  Private/Admin
// ✅ UPDATED: Also update provider status so they can resubmit
const rejectProviderSubmission = asyncHandler(async (req, res) => {
  const { rejectionReason, adminNotes } = req.body;
  
  const submission = await ProviderSubmission.findById(req.params.id);

  if (!submission) {
    res.status(404);
    throw new Error('Submission not found');
  }

  if (submission.status !== 'pending_review') {
    res.status(400);
    throw new Error(`Submission already ${submission.status}`);
  }

  // ✅ Update provider account status
  const provider = await Provider.findOne({ email: submission.email });
  if (provider) {
    provider.onboardingStatus = 'rejected';
    provider.verificationStatus = 'rejected';
    provider.rejectionReason = rejectionReason;
    provider.isVerified = false; // Still cannot login
    provider.canLogin = false;
    await provider.save();
  }

  // Update submission status
  submission.status = 'rejected';
  submission.rejectionReason = rejectionReason;
  submission.adminNotes = adminNotes;
  submission.reviewedAt = new Date();
  submission.reviewedBy = req.user._id;
  await submission.save();

  // Log admin activity
  req.user.logActivity(
    'reject_provider_submission',
    submission._id,
    'ProviderSubmission',
    `Rejected provider submission: ${submission.fullName}`
  );
  await req.user.save();

  // Send rejection email
  try {
    await sendEmail({
      email: submission.email,
      subject: 'Provider Application Update - MetroMatrix',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1>Application Status Update</h1>
          <p>Dear ${submission.fullName},</p>
          <p>Thank you for your interest in becoming a provider on MetroMatrix.</p>
          <p>After careful review, we regret to inform you that we cannot approve your application at this time.</p>
          
          ${rejectionReason ? `
            <div style="background: #fef2f2; padding: 15px; border-left: 4px solid #ef4444; margin: 20px 0;">
              <strong>Reason:</strong> ${rejectionReason}
            </div>
          ` : ''}
          
          <p>You may resubmit your application after addressing the issues mentioned above.</p>
          
          <p>If you have any questions, please contact our support team.</p>
          
          <p>Best regards,<br/>The MetroMatrix Team</p>
        </div>
      `,
    });
  } catch (error) {
    console.error('Error sending rejection email:', error);
  }

  res.json({
    success: true,
    message: 'Provider application rejected',
  });
});

module.exports = {
  adminLogin,
  getDashboardStats,
  getPendingProviders,
  getProviderForReview,
  approveProvider,
  rejectProvider,
  getAllUsers,
  getAllProviders,
  deactivateUser,
  activateUser,
  deactivateProvider,
  activateProvider,
  deletePost,
  submitProviderApplication,
  checkSubmissionStatus,
  getProviderSubmissions,
  getProviderSubmissionById,
  approveProviderSubmission,
  rejectProviderSubmission,
};