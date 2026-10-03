const asyncHandler = require('express-async-handler');
const Provider = require('../models/Provider');
const { notifyProviderSubmitted } = require('../services/adminEmailService');
const logger = require('../utils/logger');

/*
 * Provider onboarding submission — called by the PROVIDER app, not the admin
 * console, although it lives under /api/admin/provider-submissions for
 * historical reasons. Moved out of adminController unchanged in behaviour.
 *
 * Known gap (docs/ADMIN_OPEN_ITEMS.md): it identifies the provider by the
 * email in the request body and needs no token, although email verification
 * already gives the provider one. Requiring that token needs a matching
 * provider-app change.
 */

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
    await require('../services/notificationService').notifyProviderSubmitted(provider);
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

module.exports = { submitProviderApplication, checkSubmissionStatus };
