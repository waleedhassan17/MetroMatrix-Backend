const asyncHandler = require('express-async-handler');
const Admin = require('../models/Admin');
const User = require('../models/User');
const Provider = require('../models/Provider');
const ProviderDocument = require('../models/ProviderDocument');
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
    const tokens = generateTokens(admin._id);

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
  const tokens = generateTokens(provider._id);

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
};