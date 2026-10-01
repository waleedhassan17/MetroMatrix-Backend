const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const Provider = require('../models/Provider');
const ProviderDocument = require('../models/ProviderDocument');
const Post = require('../models/Post');
const { sendEmail } = require('../services/emailService');
const { notifyProviderSubmitted, escapeHtml } = require('../services/adminEmailService');
const logger = require('../utils/logger');
const auditService = require('../services/auditService');
const { softDeleteAccount, restoreAccount } = require('../services/admin/accountDeletion');
const AppError = require('../utils/AppError');
const { ERROR_CODES } = require('../utils/errorCodes');
const { ok } = require('../utils/apiResponse');

// Core admin actions are recorded in the unified AdminAuditLog. (They used to
// go to Admin.activityLog, whose fixed action enum made the save fail — AFTER
// the delete/approval had already happened — for actions it didn't list.)
const audit = (req, entry) => auditService.audit(req, { module: 'core', ...entry });

// Reason for a deletion: body (DELETE with a JSON body) or ?reason=.
const deletionReason = (req) => String(req.body?.reason || req.query?.reason || '').trim();

// Soft-delete a user or provider (services/admin/accountDeletion.js): refused
// with 409 + reasons while anything is still open; audited.
const deleteAccount = (kind, param) =>
  asyncHandler(async (req, res) => {
    const reason = deletionReason(req);
    if (!reason) throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'A reason is required to delete an account');
    const Model = kind === 'User' ? User : Provider;
    const account = await Model.findById(req.params[param]);
    if (!account) throw new AppError(ERROR_CODES.NOT_FOUND, `${kind} not found`);

    const { deletedAt } = await softDeleteAccount(kind, account, { admin: req.user, reason });
    await audit(req, {
      action: `${kind.toLowerCase()}.delete`,
      targetType: kind,
      targetId: account._id,
      before: { email: account.email, isActive: account.isActive },
      after: { deletedAt },
      reason,
    });
    ok(res, { id: String(account._id), deletedAt, restorable: true });
  });

// Undo a soft delete — super admin only (route guard).
const restoreAccountHandler = (kind, param) =>
  asyncHandler(async (req, res) => {
    const restored = await restoreAccount(kind, req.params[param]);
    await audit(req, {
      action: `${kind.toLowerCase()}.restore`,
      targetType: kind,
      targetId: req.params[param],
      before: { deletedAt: restored.deletedAt },
      after: { deletedAt: null, email: restored.restoredEmail },
      reason: String(req.body?.reason || ''),
    });
    ok(res, { id: String(req.params[param]), restored: true, email: restored.restoredEmail });
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

// @desc    Deactivate provider
// @route   PUT /api/admin/providers/:id/deactivate
// @access  Private/Admin
const deactivateProvider = asyncHandler(async (req, res) => {
  // The route parameter is :providerId — reading req.params.id made this a
  // permanent 404.
  const provider = await Provider.findById(req.params.providerId);

  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }

  const before = { isActive: provider.isActive };
  provider.isActive = false;
  await provider.save();

  await audit(req, {
    action: 'provider.deactivate',
    targetType: 'Provider',
    targetId: provider._id,
    before,
    after: { isActive: false },
    reason: req.body?.reason,
  });

  res.json({
    success: true,
    message: 'Provider deactivated successfully',
  });
});

// @desc    Activate provider
// @route   PUT /api/admin/providers/:id/activate
// @access  Private/Admin
const activateProvider = asyncHandler(async (req, res) => {
  const provider = await Provider.findById(req.params.providerId);

  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }

  const before = { isActive: provider.isActive };
  provider.isActive = true;
  await provider.save();

  await audit(req, {
    action: 'provider.activate',
    targetType: 'Provider',
    targetId: provider._id,
    before,
    after: { isActive: true },
    reason: req.body?.reason,
  });

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

  await audit(req, {
    action: 'post.delete',
    targetType: 'Post',
    targetId: post._id,
    before: { author: post.author || post.user || null, content: String(post.content || '').slice(0, 200) },
    reason: req.body?.reason,
  });

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
    await notifyProviderSubmitted(provider);
  } catch (error) {
    logger.error('Error sending admin notification:', error);
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

// ===== NEW ADMIN PANEL ENDPOINTS =====

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

  const before = { adminVerified: provider.adminVerified, status: provider.status };
  provider.adminVerified = 'active'; // ✅ Allow login
  provider.status = 'approved'; // ✅ New status field
  provider.verificationStatus = 'approved';
  provider.isVerified = true;
  provider.canLogin = true;
  provider.approvedAt = new Date();
  provider.approvedBy = req.user._id;
  if (adminNotes) provider.adminNotes = adminNotes;

  await provider.save();

  await audit(req, {
    action: 'provider.approve',
    targetType: 'Provider',
    targetId: provider._id,
    before,
    after: { adminVerified: 'active', status: 'approved' },
    reason: adminNotes,
  });

  // Send approval email
  try {
    await sendEmail({
      email: provider.email,
      subject: 'Application Approved - Welcome to MetroMatrix!',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #10b981;">Congratulations! Your Application is Approved</h2>
          <p>Dear ${escapeHtml(provider.fullName)},</p>
          <p>We're excited to inform you that your application has been approved! You can now log in and start using MetroMatrix.</p>
          <p>You can now access all features and start offering your services to our users.</p>
          <p>If you have any questions, please don't hesitate to contact our support team.</p>
          <p>Best regards,<br/>The MetroMatrix Team</p>
        </div>
      `,
    });
  } catch (error) {
    logger.error('Error sending approval email:', error);
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

  const before = { adminVerified: provider.adminVerified, status: provider.status };
  provider.adminVerified = 'inactive'; // ✅ Block login
  provider.status = 'rejected'; // ✅ New status field
  provider.verificationStatus = 'rejected';
  provider.rejectionReason = reason;
  provider.rejectedAt = new Date();
  provider.rejectedBy = req.user._id;
  if (adminNotes) provider.adminNotes = adminNotes;

  await provider.save();

  await audit(req, {
    action: 'provider.reject',
    targetType: 'Provider',
    targetId: provider._id,
    before,
    after: { adminVerified: 'inactive', status: 'rejected' },
    reason,
  });

  // Send rejection email
  try {
    await sendEmail({
      email: provider.email,
      subject: 'Application Update - MetroMatrix',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #ef4444;">Application Status Update</h2>
          <p>Dear ${escapeHtml(provider.fullName)},</p>
          <p>Thank you for your interest in joining MetroMatrix. After careful review, we are unable to approve your application at this time.</p>
          <p><strong>Reason:</strong> ${escapeHtml(reason)}</p>
          <p>You may resubmit your application after addressing the issues mentioned above.</p>
          <p>If you have any questions, please contact our support team.</p>
          <p>Best regards,<br/>The MetroMatrix Team</p>
        </div>
      `,
    });
  } catch (error) {
    logger.error('Error sending rejection email:', error);
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

// @route   DELETE /api/admin/providers/:providerId   { reason }
const deleteProvider = deleteAccount('Provider', 'providerId');
// @route   POST /api/admin/providers/:providerId/restore
const restoreProvider = restoreAccountHandler('Provider', 'providerId');

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
  
  const before = { isActive: user.isActive };
  user.isActive = true;
  await user.save();

  await audit(req, {
    action: 'user.activate',
    targetType: 'User',
    targetId: user._id,
    before,
    after: { isActive: true },
    reason: req.body?.reason,
  });

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
  
  const before = { isActive: user.isActive };
  user.isActive = false;
  // Also end their ability to renew a session (protect already refuses
  // inactive accounts on every request).
  user.refreshToken = undefined;
  await user.save();

  await audit(req, {
    action: 'user.deactivate',
    targetType: 'User',
    targetId: user._id,
    before,
    after: { isActive: false },
    reason,
  });

  res.json({
    success: true,
    message: 'User deactivated successfully',
    data: {
      id: user._id,
      isActive: false,
    },
  });
});

// @route   DELETE /api/admin/users/:userId      { reason }
const deleteUser = deleteAccount('User', 'userId');
// @route   POST /api/admin/users/:userId/restore
const restoreUser = restoreAccountHandler('User', 'userId');

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

module.exports = {
  getDashboardStats,
  deactivateProvider,
  activateProvider,
  deletePost,
  submitProviderApplication,
  checkSubmissionStatus,
  // New enhanced endpoints
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
  restoreUser,
  restoreProvider,
  // Frontend compatibility endpoints
  getRecentRegistrations,
  getProvidersByType,
  getProviderDetailsWithRoute,
  getAnalytics,
};