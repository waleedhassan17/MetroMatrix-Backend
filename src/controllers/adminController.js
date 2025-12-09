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
    return res.status(401).json({
      success: false,
      message: 'Invalid email or password',
      error: 'INVALID_CREDENTIALS',
    });
  }

  if (!admin.isActive) {
    return res.status(403).json({
      success: false,
      message: 'Your admin account has been deactivated',
      error: 'ACCOUNT_DEACTIVATED',
    });
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
      message: 'Login successful',
      admin: {
        id: admin._id,
        _id: admin._id,
        email: admin.email,
        fullName: admin.fullName,
        role: admin.role,
        avatar: admin.avatar || admin.profilePhoto,
        permissions: admin.permissions,
        isActive: admin.isActive,
        lastLoginDate: admin.lastLoginDate,
        createdAt: admin.createdAt,
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: 86400, // 24 hours in seconds
    });
  } else {
    return res.status(401).json({
      success: false,
      message: 'Invalid email or password',
      error: 'INVALID_CREDENTIALS',
    });
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

  // Update status to approved
  provider.adminVerified = 'active'; // ✅ New flag: Set to 'active'
  provider.verificationStatus = 'approved';
  provider.onboardingStatus = 'approved';
  provider.isVerified = true;
  provider.canLogin = true;
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

  provider.adminVerified = 'inactive'; // ✅ New flag: Set to 'inactive'
  provider.verificationStatus = 'rejected';
  provider.rejectionReason = reason;
  provider.verifiedBy = req.user._id;
  provider.rejectedAt = new Date();
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
// ⚠️ CRITICAL: Provider profile submission endpoint - NO AUTH REQUIRED
// Identifies provider by email (not providerId), updates provider record with profile data
const submitProviderApplication = asyncHandler(async (req, res) => {
  const {
    email, // ⚠️ CRITICAL: Provider identified by email
    providerType,
    providerSubType,
    fullName,
    phoneNumber,
    specialty,
    profession,
    category,
    experience,
    rate,
    briefDescription,
    city,
    idNumber,
    professionalName,
    businessName,
  } = req.body;

  // Validate required fields
  if (!email) {
    res.status(400);
    throw new Error('Email is required');
  }

  // 1. Find provider by email
  const provider = await Provider.findOne({ email: email.toLowerCase() });
  
  if (!provider) {
    res.status(404);
    return res.json({
      success: false,
      error: 'PROVIDER_NOT_FOUND',
      message: 'No provider found with this email. Please sign up first.'
    });
  }

  // 2. Check email is verified
  if (provider.emailVerified !== 'active') {
    res.status(403);
    return res.json({
      success: false,
      error: 'EMAIL_NOT_VERIFIED',
      message: 'Please verify your email before submitting your profile.'
    });
  }

  // 3. Check if already submitted
  if (provider.status === 'pending_review' || provider.status === 'approved') {
    res.status(400);
    return res.json({
      success: false,
      error: 'ALREADY_SUBMITTED',
      message: 'Your profile has already been submitted.'
    });
  }

  // 4. Upload documents to cloud storage
  const documents = {};
  
  if (req.files) {
    if (req.files.medicalLicense) {
      documents.medicalLicense = {
        url: req.files.medicalLicense[0].path,
        publicId: req.files.medicalLicense[0].filename,
        uploadedAt: new Date(),
      };
    }
    if (req.files.degreeCertificate) {
      documents.degreeCertificate = {
        url: req.files.degreeCertificate[0].path,
        publicId: req.files.degreeCertificate[0].filename,
        uploadedAt: new Date(),
      };
    }
    if (req.files.professionalCertificate) {
      documents.professionalCertificate = {
        url: req.files.professionalCertificate[0].path,
        publicId: req.files.professionalCertificate[0].filename,
        uploadedAt: new Date(),
      };
    }
    if (req.files.businessLicense) {
      documents.businessLicense = {
        url: req.files.businessLicense[0].path,
        publicId: req.files.businessLicense[0].filename,
        uploadedAt: new Date(),
      };
    }
    if (req.files.nationalIdCard) {
      documents.nationalIdCard = {
        url: req.files.nationalIdCard[0].path,
        publicId: req.files.nationalIdCard[0].filename,
        uploadedAt: new Date(),
      };
    }
  }

  // 5. Update provider record with profile data
  provider.providerType = providerType || provider.providerType;
  provider.providerSubType = providerSubType;
  provider.fullName = fullName || provider.fullName;
  provider.phoneNumber = phoneNumber || provider.phoneNumber;
  provider.specialty = specialty;
  provider.profession = profession;
  provider.category = category;
  provider.experience = experience;
  provider.briefDescription = briefDescription;
  provider.city = city;
  provider.idNumber = idNumber;
  provider.professionalName = professionalName;
  provider.businessName = businessName;
  provider.rate = rate;
  provider.documents = documents;
  provider.status = 'pending_review'; // ✅ Critical status change
  provider.onboardingStatus = 'pending_approval';
  provider.submittedAt = new Date(); // ✅ Track submission time
  
  await provider.save();

  // 6. Notify admin
  try {
    await sendEmail({
      email: process.env.ADMIN_EMAIL || 'waleedhassansfd@gmail.com',
      subject: 'New Provider Profile Submitted - Review Required',
      html: `
        <h2>Provider Profile Submitted</h2>
        <p><strong>Name:</strong> ${provider.fullName}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Type:</strong> ${providerType}</p>
        <p><strong>City:</strong> ${city}</p>
        <p>Please review this provider's profile in the admin dashboard.</p>
      `,
    });
  } catch (error) {
    console.error('Error sending admin notification:', error);
  }

  // 7. Return success
  res.status(200).json({
    success: true,
    message: 'Profile submitted for admin review',
    submissionId: provider._id,
    status: 'pending_review'
  });
});

// @desc    Check provider approval status by email (PUBLIC - no auth)
// @route   GET /api/admin/provider-submissions/check-status
// @access  Public
const checkSubmissionStatus = asyncHandler(async (req, res) => {
  const { email } = req.query;

  if (!email) {
    res.status(400);
    throw new Error('Email is required');
  }

  // Find provider by email
  const provider = await Provider.findOne({ email: email.toLowerCase() })
    .select('email fullName emailVerified adminVerified status submittedAt approvedAt rejectedAt rejectionReason');

  if (!provider) {
    res.status(404);
    return res.json({
      success: false,
      error: 'PROVIDER_NOT_FOUND',
      message: 'No provider found with this email'
    });
  }

  const response = {
    success: true,
    status: provider.status,
    message: getStatusMessage(provider.status),
    provider: {
      id: provider._id,
      email: provider.email,
      fullName: provider.fullName,
      emailVerified: provider.emailVerified,
      adminVerified: provider.adminVerified,
      status: provider.status
    }
  };

  if (provider.submittedAt) {
    response.submittedAt = provider.submittedAt;
  }

  if (provider.status === 'rejected' && provider.rejectionReason) {
    response.rejectionReason = provider.rejectionReason;
    response.rejectedAt = provider.rejectedAt;
  }

  if (provider.status === 'approved') {
    response.approvedAt = provider.approvedAt;
  }

  res.json(response);
});

// Helper function to get status message
function getStatusMessage(status) {
  const messages = {
    'pending_email_verification': 'Please verify your email',
    'email_verified': 'Email verified. Please submit your profile',
    'pending_review': 'Your profile is under review',
    'approved': 'Your account has been approved',
    'rejected': 'Your application was not approved'
  };
  return messages[status] || 'Unknown status';
}

// Legacy compatibility
const checkSubmissionStatusLegacy = asyncHandler(async (req, res) => {
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

// ===== NEW ADMIN PANEL ENDPOINTS =====

// @desc    Admin logout
// @route   POST /api/admin/auth/logout
// @access  Private/Admin
const adminLogout = asyncHandler(async (req, res) => {
  const admin = req.user;
  
  admin.refreshToken = undefined;
  admin.logActivity('logout', admin._id, 'Admin', 'Admin logged out');
  await admin.save();
  
  res.json({
    success: true,
    message: 'Logged out successfully',
  });
});

// @desc    Get admin profile
// @route   GET /api/admin/profile
// @access  Private/Admin
const getAdminProfile = asyncHandler(async (req, res) => {
  const admin = await Admin.findById(req.user._id);
  
  res.json({
    success: true,
    data: {
      id: admin._id,
      _id: admin._id,
      email: admin.email,
      fullName: admin.fullName,
      role: admin.role,
      avatar: admin.avatar || admin.profilePhoto,
      permissions: admin.permissions,
      isActive: admin.isActive,
      lastLoginDate: admin.lastLoginDate,
      createdAt: admin.createdAt,
    },
  });
});

// @desc    Update admin profile
// @route   PUT /api/admin/profile
// @access  Private/Admin
const updateAdminProfile = asyncHandler(async (req, res) => {
  const admin = await Admin.findById(req.user._id);
  const { fullName, email, avatar } = req.body;
  
  if (fullName) admin.fullName = fullName;
  if (email) {
    // Check if email already exists
    const emailExists = await Admin.findOne({ email, _id: { $ne: admin._id } });
    if (emailExists) {
      res.status(409);
      throw new Error('Email already in use');
    }
    admin.email = email;
  }
  if (avatar) {
    admin.avatar = avatar;
    admin.profilePhoto = avatar;
  }
  
  await admin.save();
  
  res.json({
    success: true,
    message: 'Profile updated successfully',
    data: {
      id: admin._id,
      email: admin.email,
      fullName: admin.fullName,
      avatar: admin.avatar,
    },
  });
});

// @desc    Change admin password
// @route   PUT /api/admin/change-password
// @access  Private/Admin
const changeAdminPassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  
  if (!currentPassword || !newPassword) {
    res.status(400);
    throw new Error('Please provide current and new password');
  }
  
  const admin = await Admin.findById(req.user._id).select('+password');
  
  const isMatch = await admin.matchPassword(currentPassword);
  if (!isMatch) {
    res.status(401);
    throw new Error('Current password is incorrect');
  }
  
  admin.password = newPassword;
  await admin.save();
  
  res.json({
    success: true,
    message: 'Password changed successfully',
  });
});

// @desc    Get dashboard statistics (Enhanced)
// @route   GET /api/admin/dashboard/stats
// @access  Private/Admin
// ✅ UPDATED: Match frontend expected format exactly
const getDashboardStatsEnhanced = asyncHandler(async (req, res) => {
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  
  // Provider stats
  const [totalProviders, pendingProviders, approvedProviders, rejectedProviders, 
         providersLastMonth, providersTwoMonthsAgo] = await Promise.all([
    Provider.countDocuments(),
    Provider.countDocuments({ adminVerified: 'pending' }),
    Provider.countDocuments({ adminVerified: 'active' }),
    Provider.countDocuments({ adminVerified: 'inactive' }),
    Provider.countDocuments({ createdAt: { $gte: lastMonth } }),
    Provider.countDocuments({ createdAt: { $gte: twoMonthsAgo, $lt: lastMonth } }),
  ]);
  
  const providerGrowth = providersTwoMonthsAgo > 0 
    ? ((providersLastMonth - providersTwoMonthsAgo) / providersTwoMonthsAgo * 100).toFixed(1)
    : 0;
  
  // User stats
  const [totalUsers, activeUsers, inactiveUsers, usersLastMonth, usersTwoMonthsAgo, usersThisMonth] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ isActive: true }),
    User.countDocuments({ isActive: false }),
    User.countDocuments({ createdAt: { $gte: lastMonth } }),
    User.countDocuments({ createdAt: { $gte: twoMonthsAgo, $lt: lastMonth } }),
    User.countDocuments({ createdAt: { $gte: thisMonthStart } }),
  ]);
  
  const userGrowth = usersTwoMonthsAgo > 0 
    ? ((usersLastMonth - usersTwoMonthsAgo) / usersTwoMonthsAgo * 100).toFixed(1)
    : 0;
  
  // Post stats
  const [totalPosts, postsThisMonth, postsLastMonth] = await Promise.all([
    Post.countDocuments(),
    Post.countDocuments({ createdAt: { $gte: thisMonthStart } }),
    Post.countDocuments({ createdAt: { $gte: lastMonth, $lt: thisMonthStart } }),
  ]);
  
  const postGrowth = postsLastMonth > 0 
    ? ((postsThisMonth - postsLastMonth) / postsLastMonth * 100).toFixed(1)
    : 0;
  
  // Provider distribution by type
  const providerDistribution = await Provider.aggregate([
    { $match: { adminVerified: 'active' } },
    { $group: { _id: '$providerType', count: { $sum: 1 } } },
  ]);
  
  const totalApproved = providerDistribution.reduce((sum, item) => sum + item.count, 0);
  const byType = providerDistribution.map(item => ({
    type: item._id,
    count: item.count,
    percentage: totalApproved > 0 ? Math.round((item.count / totalApproved) * 100) : 0,
  }));
  
  // Recent registrations (last 10 pending providers)
  const recentRegistrations = await Provider.find()
    .sort({ createdAt: -1 })
    .limit(10)
    .select('fullName email providerType providerSubType specialty adminVerified verificationStatus createdAt profilePhoto');
  
  // Quick stats
  const onlineProviders = await Provider.countDocuments({ isOnline: true, adminVerified: 'active' });
  
  // ✅ Frontend expected format
  res.json({
    success: true,
    data: {
      totalUsers,
      totalProviders,
      pendingProviders,
      totalPosts,
      activeUsers,
      growth: {
        users: parseFloat(userGrowth),
        providers: parseFloat(providerGrowth),
        posts: parseFloat(postGrowth),
      },
      recentRegistrations: recentRegistrations.map(p => ({
        id: p._id,
        _id: p._id,
        fullName: p.fullName,
        email: p.email,
        providerType: p.providerType,
        specialty: p.specialty || null,
        subType: p.providerSubType || null,
        verificationStatus: p.verificationStatus || 'pending',
        createdAt: p.createdAt,
        avatar: p.profilePhoto || null,
      })),
    },
    // Also include detailed stats for advanced dashboards
    stats: {
      providers: {
        total: totalProviders,
        pending: pendingProviders,
        approved: approvedProviders,
        rejected: rejectedProviders,
        growthPercentage: parseFloat(providerGrowth),
        byType,
      },
      users: {
        total: totalUsers,
        active: activeUsers,
        inactive: inactiveUsers,
        newThisMonth: usersThisMonth,
        growthPercentage: parseFloat(userGrowth),
      },
      posts: {
        total: totalPosts,
        thisMonth: postsThisMonth,
      },
      quickStats: {
        online: onlineProviders,
        pendingReviews: pendingProviders,
      },
    },
  });
});

// @desc    Get quick stats (real-time)
// @route   GET /api/admin/dashboard/quick-stats
// @access  Private/Admin
const getQuickStats = asyncHandler(async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const [online, pending, todayRegistrations, activeProviders] = await Promise.all([
    Provider.countDocuments({ isOnline: true, adminVerified: 'active' }),
    Provider.countDocuments({ adminVerified: 'pending' }),
    Provider.countDocuments({ createdAt: { $gte: today } }),
    Provider.countDocuments({ isActive: true, adminVerified: 'active' }),
  ]);
  
  res.json({
    success: true,
    stats: {
      online,
      pendingReviews: pending,
      todayRegistrations,
      activeProviders,
    },
  });
});

// @desc    Get all providers (Enhanced with filters)
// @route   GET /api/admin/providers
// @access  Private/Admin
const getAllProvidersEnhanced = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 15,
    status = 'all',
    providerType = 'all',
    search = '',
    city = '',
    isActive = '',
    sortBy = 'createdAt',
    sortOrder = 'desc',
  } = req.query;
  
  const query = {};
  
  // Status filter (map to adminVerified)
  if (status && status !== 'all') {
    if (status === 'pending') query.adminVerified = 'pending';
    else if (status === 'approved') query.adminVerified = 'active';
    else if (status === 'rejected') query.adminVerified = 'inactive';
  }
  
  // Provider type filter
  if (providerType && providerType !== 'all') {
    query.providerType = providerType;
  }
  
  // Search filter
  if (search) {
    query.$or = [
      { fullName: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { phoneNumber: { $regex: search, $options: 'i' } },
    ];
  }
  
  // City filter
  if (city) {
    query.city = { $regex: city, $options: 'i' };
  }
  
  // Active status filter
  if (isActive !== '') {
    query.isActive = isActive === 'true';
  }
  
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };
  
  // Get providers and total count
  const [providers, total, totalActive, totalInactive, totalPending, totalApproved, totalRejected] = await Promise.all([
    Provider.find(query)
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .select('-password -emailVerificationToken -refreshToken'),
    Provider.countDocuments(query),
    Provider.countDocuments({ isActive: true }),
    Provider.countDocuments({ isActive: false }),
    Provider.countDocuments({ adminVerified: 'pending' }),
    Provider.countDocuments({ adminVerified: 'active' }),
    Provider.countDocuments({ adminVerified: 'inactive' }),
  ]);
  
  const pages = Math.ceil(total / parseInt(limit));
  const currentPage = parseInt(page);
  
  res.json({
    success: true,
    providers: providers.map(p => ({
      id: p._id,
      _id: p._id,
      email: p.email,
      fullName: p.fullName,
      phoneNumber: p.phoneNumber,
      providerType: p.providerType,
      providerSubType: p.providerSubType,
      specialty: p.specialty,
      profession: p.profession,
      category: p.category,
      experience: p.experience,
      briefDescription: p.briefDescription,
      rate: p.rate,
      consultationFee: p.consultationFee,
      professionalName: p.professionalName,
      businessName: p.businessName,
      city: p.city,
      address: p.address,
      coordinates: p.coordinates,
      idNumber: p.idNumber,
      documents: p.documents,
      profileComplete: p.profileComplete,
      emailVerified: p.emailVerified === 'active',
      verificationStatus: p.adminVerified === 'active' ? 'approved' : p.adminVerified === 'inactive' ? 'rejected' : 'pending',
      adminVerified: p.adminVerified,
      rejectionReason: p.rejectionReason,
      isActive: p.isActive,
      isOnline: p.isOnline,
      ratings: p.ratings,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      approvedAt: p.approvedAt,
      approvedBy: p.approvedBy,
    })),
    pagination: {
      page: currentPage,
      limit: parseInt(limit),
      total,
      pages,
      hasNext: currentPage < pages,
      hasPrev: currentPage > 1,
    },
    stats: {
      total: totalApproved + totalPending + totalRejected,
      pending: totalPending,
      approved: totalApproved,
      rejected: totalRejected,
      active: totalActive,
      inactive: totalInactive,
    },
  });
});

// @desc    Get pending providers
// @route   GET /api/admin/providers/pending
// @access  Private/Admin
const getPendingProvidersEnhanced = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    providerType = 'all',
  } = req.query;
  
  const query = { adminVerified: 'pending' };
  
  if (providerType && providerType !== 'all') {
    query.providerType = providerType;
  }
  
  const skip = (parseInt(page) - 1) * parseInt(limit);
  
  const [providers, total] = await Promise.all([
    Provider.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select('-password -emailVerificationToken -refreshToken'),
    Provider.countDocuments(query),
  ]);
  
  res.json({
    success: true,
    providers: providers.map(p => ({
      id: p._id,
      fullName: p.fullName,
      email: p.email,
      phoneNumber: p.phoneNumber,
      providerType: p.providerType,
      providerSubType: p.providerSubType,
      experience: p.experience,
      briefDescription: p.briefDescription,
      rate: p.rate,
      city: p.city,
      idNumber: p.idNumber,
      documents: p.documents,
      verificationStatus: 'pending',
      createdAt: p.createdAt,
    })),
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit)),
    },
    count: total,
  });
});

// @desc    Get provider details
// @route   GET /api/admin/providers/:providerId
// @access  Private/Admin
const getProviderDetails = asyncHandler(async (req, res) => {
  const provider = await Provider.findById(req.params.providerId)
    .select('-password -emailVerificationToken -refreshToken');
  
  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }
  
  res.json({
    success: true,
    provider: {
      id: provider._id,
      _id: provider._id,
      email: provider.email,
      fullName: provider.fullName,
      phoneNumber: provider.phoneNumber,
      providerType: provider.providerType,
      providerSubType: provider.providerSubType,
      specialty: provider.specialty,
      profession: provider.profession,
      category: provider.category,
      experience: provider.experience,
      briefDescription: provider.briefDescription,
      consultationFee: provider.consultationFee,
      rate: provider.rate,
      professionalName: provider.professionalName,
      businessName: provider.businessName,
      city: provider.city,
      address: provider.address,
      coordinates: provider.coordinates,
      idNumber: provider.idNumber,
      documents: provider.documents,
      ratings: provider.ratings,
      profileComplete: provider.profileComplete,
      emailVerified: provider.emailVerified === 'active',
      verificationStatus: provider.adminVerified === 'active' ? 'approved' : provider.adminVerified === 'inactive' ? 'rejected' : 'pending',
      adminVerified: provider.adminVerified,
      rejectionReason: provider.rejectionReason,
      isActive: provider.isActive,
      isOnline: provider.isOnline,
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
      approvedAt: provider.approvedAt,
      approvedBy: provider.approvedBy,
    },
  });
});

// @desc    Approve provider (Updated)
// @route   PUT /api/admin/providers/:providerId/approve
// @access  Private/Admin
const approveProviderEnhanced = asyncHandler(async (req, res) => {
  const { adminNotes } = req.body;
  const provider = await Provider.findById(req.params.providerId);
  
  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }
  
  provider.adminVerified = 'active'; // ✅ Allow login
  provider.status = 'approved'; // ✅ New status field
  provider.verificationStatus = 'approved';
  provider.isVerified = true;
  provider.canLogin = true;
  provider.approvedAt = new Date();
  provider.approvedBy = req.user._id;
  if (adminNotes) provider.adminNotes = adminNotes;
  
  await provider.save();
  
  // Log activity
  req.user.logActivity('approve_provider', provider._id, 'Provider', 
    `Approved provider: ${provider.fullName}`);
  await req.user.save();
  
  // Send approval email
  try {
    await sendEmail({
      email: provider.email,
      subject: 'Application Approved - Welcome to MetroMatrix!',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #10b981;">Congratulations! Your Application is Approved</h2>
          <p>Dear ${provider.fullName},</p>
          <p>We're excited to inform you that your application has been approved! You can now log in and start using MetroMatrix.</p>
          <p>You can now access all features and start offering your services to our users.</p>
          <p>If you have any questions, please don't hesitate to contact our support team.</p>
          <p>Best regards,<br/>The MetroMatrix Team</p>
        </div>
      `,
    });
  } catch (error) {
    console.error('Error sending approval email:', error);
  }
  
  res.json({
    success: true,
    message: 'Provider approved successfully',
    data: {
      id: provider._id,
      verificationStatus: 'approved',
      approvedAt: provider.approvedAt,
      approvedBy: req.user._id,
    },
  });
});

// @desc    Reject provider (Updated)
// @route   PUT /api/admin/providers/:providerId/reject
// @access  Private/Admin
const rejectProviderEnhanced = asyncHandler(async (req, res) => {
  const { reason, adminNotes } = req.body;
  
  if (!reason) {
    res.status(400);
    throw new Error('Rejection reason is required');
  }
  
  const provider = await Provider.findById(req.params.providerId);
  
  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }
  
  provider.adminVerified = 'inactive'; // ✅ Block login
  provider.status = 'rejected'; // ✅ New status field
  provider.verificationStatus = 'rejected';
  provider.rejectionReason = reason;
  provider.rejectedAt = new Date();
  provider.rejectedBy = req.user._id;
  if (adminNotes) provider.adminNotes = adminNotes;
  
  await provider.save();
  
  // Log activity
  req.user.logActivity('reject_provider', provider._id, 'Provider', 
    `Rejected provider: ${provider.fullName}. Reason: ${reason}`);
  await req.user.save();
  
  // Send rejection email
  try {
    await sendEmail({
      email: provider.email,
      subject: 'Application Update - MetroMatrix',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #ef4444;">Application Status Update</h2>
          <p>Dear ${provider.fullName},</p>
          <p>Thank you for your interest in joining MetroMatrix. After careful review, we are unable to approve your application at this time.</p>
          <p><strong>Reason:</strong> ${reason}</p>
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
    message: 'Provider rejected successfully',
    data: {
      id: provider._id,
      verificationStatus: 'rejected',
      rejectionReason: reason,
      rejectedAt: provider.rejectedAt,
      rejectedBy: req.user._id,
    },
  });
});

// @desc    Delete provider
// @route   DELETE /api/admin/providers/:providerId
// @access  Private/Admin
const deleteProvider = asyncHandler(async (req, res) => {
  const provider = await Provider.findById(req.params.providerId);
  
  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }
  
  await Provider.deleteOne({ _id: provider._id });
  
  // Log activity
  req.user.logActivity('delete_provider', provider._id, 'Provider', 
    `Deleted provider: ${provider.fullName}`);
  await req.user.save();
  
  res.json({
    success: true,
    message: 'Provider deleted successfully',
  });
});

// @desc    Get all users (Enhanced)
// @route   GET /api/admin/users
// @access  Private/Admin
const getAllUsersEnhanced = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 15,
    search = '',
    isActive = '',
    isVerified = '',
    sortBy = 'createdAt',
    sortOrder = 'desc',
  } = req.query;
  
  const query = {};
  
  // Search filter
  if (search) {
    query.$or = [
      { fullName: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { phoneNumber: { $regex: search, $options: 'i' } },
    ];
  }
  
  // Active status filter
  if (isActive !== '') {
    query.isActive = isActive === 'true';
  }
  
  // Verified status filter
  if (isVerified !== '') {
    query.isVerified = isVerified === 'true';
  }
  
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };
  
  // Get users, total, and stats
  const [users, total, totalActive, totalInactive] = await Promise.all([
    User.find(query)
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .select('-password -refreshToken'),
    User.countDocuments(query),
    User.countDocuments({ isActive: true }),
    User.countDocuments({ isActive: false }),
  ]);
  
  const pages = Math.ceil(total / parseInt(limit));
  const currentPage = parseInt(page);
  
  res.json({
    success: true,
    users: users.map(u => ({
      id: u._id,
      _id: u._id,
      fullName: u.fullName,
      email: u.email,
      phoneNumber: u.phoneNumber,
      profileImage: u.profileImage || u.profilePhoto,
      isActive: u.isActive,
      isVerified: u.isVerified,
      emailVerified: u.emailVerified,
      address: u.address,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
      lastLogin: u.lastLoginDate,
    })),
    pagination: {
      page: currentPage,
      limit: parseInt(limit),
      total,
      pages,
      hasNext: currentPage < pages,
      hasPrev: currentPage > 1,
    },
    stats: {
      total: totalActive + totalInactive,
      active: totalActive,
      inactive: totalInactive,
    },
  });
});

// @desc    Get user details
// @route   GET /api/admin/users/:userId
// @access  Private/Admin
const getUserDetails = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.userId)
    .select('-password -refreshToken');
  
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  
  // Get additional stats
  const [postsCount] = await Promise.all([
    Post.countDocuments({ author: user._id }),
  ]);
  
  res.json({
    success: true,
    user: {
      id: user._id,
      _id: user._id,
      fullName: user.fullName,
      email: user.email,
      phoneNumber: user.phoneNumber,
      profileImage: user.profileImage || user.profilePhoto,
      isActive: user.isActive,
      isVerified: user.isVerified,
      emailVerified: user.emailVerified,
      address: user.address,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLogin: user.lastLoginDate,
      postsCount,
    },
  });
});

// @desc    Activate user
// @route   PUT /api/admin/users/:userId/activate
// @access  Private/Admin
const activateUserEnhanced = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.userId);
  
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  
  user.isActive = true;
  await user.save();
  
  // Log activity
  req.user.logActivity('activate_user', user._id, 'User', 
    `Activated user: ${user.fullName}`);
  await req.user.save();
  
  res.json({
    success: true,
    message: 'User activated successfully',
    data: {
      id: user._id,
      isActive: true,
    },
  });
});

// @desc    Deactivate user
// @route   PUT /api/admin/users/:userId/deactivate
// @access  Private/Admin
const deactivateUserEnhanced = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const user = await User.findById(req.params.userId);
  
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  
  user.isActive = false;
  await user.save();
  
  // Log activity
  req.user.logActivity('deactivate_user', user._id, 'User', 
    `Deactivated user: ${user.fullName}${reason ? '. Reason: ' + reason : ''}`);
  await req.user.save();
  
  res.json({
    success: true,
    message: 'User deactivated successfully',
    data: {
      id: user._id,
      isActive: false,
    },
  });
});

// @desc    Delete user
// @route   DELETE /api/admin/users/:userId
// @access  Private/Admin
const deleteUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.userId);
  
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  
  await User.deleteOne({ _id: user._id });
  
  // Log activity
  req.user.logActivity('delete_user', user._id, 'User', 
    `Deleted user: ${user.fullName}`);
  await req.user.save();
  
  res.json({
    success: true,
    message: 'User deleted successfully',
  });
});

// @desc    Get recent registrations
// @route   GET /api/admin/dashboard/recent-registrations
// @access  Private/Admin
const getRecentRegistrations = asyncHandler(async (req, res) => {
  const { limit = 10 } = req.query;
  
  const recentProviders = await Provider.find({ adminVerified: 'pending' })
    .sort({ createdAt: -1 })
    .limit(parseInt(limit))
    .select('fullName email providerType providerSubType adminVerified createdAt profilePhoto');
  
  res.json({
    success: true,
    data: recentProviders.map(p => ({
      id: p._id,
      _id: p._id,
      fullName: p.fullName,
      email: p.email,
      providerType: p.providerType,
      providerSubType: p.providerSubType,
      verificationStatus: p.adminVerified,
      createdAt: p.createdAt,
      avatar: p.profilePhoto,
    })),
  });
});

// @desc    Get providers by type
// @route   GET /api/admin/providers/:providerType
// @access  Private/Admin
const getProvidersByType = asyncHandler(async (req, res) => {
  const { providerType } = req.params;
  const {
    page = 1,
    limit = 15,
    status = '',
    search = '',
  } = req.query;
  
  const query = { providerType };
  
  // Status filter
  if (status && status !== 'all') {
    if (status === 'pending') query.adminVerified = 'pending';
    else if (status === 'approved') query.adminVerified = 'active';
    else if (status === 'rejected') query.adminVerified = 'inactive';
  }
  
  // Search filter
  if (search) {
    query.$or = [
      { fullName: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { phoneNumber: { $regex: search, $options: 'i' } },
    ];
  }
  
  const skip = (parseInt(page) - 1) * parseInt(limit);
  
  const [providers, total] = await Promise.all([
    Provider.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select('-password -emailVerificationToken -refreshToken'),
    Provider.countDocuments(query),
  ]);
  
  res.json({
    success: true,
    providers: providers.map(p => ({
      id: p._id,
      _id: p._id,
      email: p.email,
      fullName: p.fullName,
      phoneNumber: p.phoneNumber,
      providerType: p.providerType,
      providerSubType: p.providerSubType,
      specialty: p.specialty,
      experience: p.experience,
      briefDescription: p.briefDescription,
      rate: p.rate,
      consultationFee: p.consultationFee,
      city: p.city,
      address: p.address,
      documents: p.documents,
      profileComplete: p.profileComplete,
      emailVerified: p.emailVerified === 'active',
      verificationStatus: p.adminVerified === 'active' ? 'approved' : p.adminVerified === 'inactive' ? 'rejected' : 'pending',
      rejectionReason: p.rejectionReason,
      isActive: p.isActive,
      isOnline: p.isOnline,
      ratings: p.ratings,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit)),
    },
  });
});

// @desc    Get provider details with /details route
// @route   GET /api/admin/providers/:providerId/details
// @access  Private/Admin
const getProviderDetailsWithRoute = asyncHandler(async (req, res) => {
  const provider = await Provider.findById(req.params.providerId)
    .select('-password -emailVerificationToken -refreshToken');
  
  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }
  
  res.json({
    success: true,
    provider: {
      id: provider._id,
      _id: provider._id,
      email: provider.email,
      fullName: provider.fullName,
      phoneNumber: provider.phoneNumber,
      providerType: provider.providerType,
      providerSubType: provider.providerSubType,
      specialty: provider.specialty,
      experience: provider.experience,
      briefDescription: provider.briefDescription,
      consultationFee: provider.consultationFee,
      rate: provider.rate,
      city: provider.city,
      address: provider.address,
      idNumber: provider.idNumber,
      documents: provider.documents,
      verificationStatus: provider.adminVerified === 'active' ? 'approved' : provider.adminVerified === 'inactive' ? 'rejected' : 'pending',
      rejectionReason: provider.rejectionReason,
      isActive: provider.isActive,
      isOnline: provider.isOnline,
      ratings: provider.ratings,
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
    },
  });
});

// @desc    Get analytics
// @route   GET /api/admin/analytics
// @access  Private/Admin
const getAnalytics = asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;
  
  const dateFilter = {};
  if (startDate) dateFilter.$gte = new Date(startDate);
  if (endDate) dateFilter.$lte = new Date(endDate);
  
  const hasDateFilter = startDate || endDate;
  
  // Provider analytics
  const providerQuery = hasDateFilter ? { createdAt: dateFilter } : {};
  const [totalProviders, providersByType, providersByStatus] = await Promise.all([
    Provider.countDocuments(providerQuery),
    Provider.aggregate([
      ...(hasDateFilter ? [{ $match: { createdAt: dateFilter } }] : []),
      { $group: { _id: '$providerType', count: { $sum: 1 } } },
    ]),
    Provider.aggregate([
      ...(hasDateFilter ? [{ $match: { createdAt: dateFilter } }] : []),
      { $group: { _id: '$adminVerified', count: { $sum: 1 } } },
    ]),
  ]);
  
  // User analytics
  const userQuery = hasDateFilter ? { createdAt: dateFilter } : {};
  const [totalUsers, activeUsers, verifiedUsers] = await Promise.all([
    User.countDocuments(userQuery),
    User.countDocuments({ ...userQuery, isActive: true }),
    User.countDocuments({ ...userQuery, isVerified: true }),
  ]);
  
  // Post analytics
  const postQuery = hasDateFilter ? { createdAt: dateFilter } : {};
  const totalPosts = await Post.countDocuments(postQuery);
  
  // Provider growth over time (last 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const providerGrowth = await Provider.aggregate([
    { $match: { createdAt: { $gte: thirtyDaysAgo } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  
  // User growth over time (last 30 days)
  const userGrowth = await User.aggregate([
    { $match: { createdAt: { $gte: thirtyDaysAgo } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  
  res.json({
    success: true,
    data: {
      providers: {
        total: totalProviders,
        byType: providersByType.map(item => ({
          type: item._id,
          count: item.count,
        })),
        byStatus: providersByStatus.map(item => ({
          status: item._id === 'active' ? 'approved' : item._id === 'inactive' ? 'rejected' : 'pending',
          count: item.count,
        })),
        growth: providerGrowth.map(item => ({
          date: item._id,
          count: item.count,
        })),
      },
      users: {
        total: totalUsers,
        active: activeUsers,
        verified: verifiedUsers,
        growth: userGrowth.map(item => ({
          date: item._id,
          count: item.count,
        })),
      },
      posts: {
        total: totalPosts,
      },
    },
  });
});

// @desc    Refresh admin token
// @route   POST /api/admin/auth/refresh-token
// @access  Public
const refreshAdminToken = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  
  if (!refreshToken) {
    return res.status(400).json({
      success: false,
      message: 'Refresh token is required',
      error: 'MISSING_REFRESH_TOKEN',
    });
  }
  
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
    
    const admin = await Admin.findById(decoded.id);
    
    if (!admin || admin.refreshToken !== refreshToken) {
      return res.status(401).json({
        success: false,
        message: 'Invalid refresh token',
        error: 'INVALID_REFRESH_TOKEN',
      });
    }
    
    if (!admin.isActive) {
      return res.status(403).json({
        success: false,
        message: 'Admin account is deactivated',
        error: 'ACCOUNT_DEACTIVATED',
      });
    }
    
    // Generate new tokens
    const { generateTokens } = require('../utils/generateToken');
    const tokens = generateTokens(admin._id, {
      userType: 'admin',
      email: admin.email,
      role: admin.role,
    });
    
    // Update refresh token
    admin.refreshToken = tokens.refreshToken;
    await admin.save();
    
    res.json({
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: 86400,
    });
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired refresh token',
      error: 'TOKEN_INVALID',
    });
  }
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
  // New enhanced endpoints
  adminLogout,
  getAdminProfile,
  updateAdminProfile,
  changeAdminPassword,
  getDashboardStatsEnhanced,
  getQuickStats,
  getAllProvidersEnhanced,
  getPendingProvidersEnhanced,
  getProviderDetails,
  approveProviderEnhanced,
  rejectProviderEnhanced,
  deleteProvider,
  getAllUsersEnhanced,
  getUserDetails,
  activateUserEnhanced,
  deactivateUserEnhanced,
  deleteUser,
  // Frontend compatibility endpoints
  getRecentRegistrations,
  getProvidersByType,
  getProviderDetailsWithRoute,
  getAnalytics,
  refreshAdminToken,
};