const asyncHandler = require('express-async-handler');
const Provider = require('../models/Provider');
const ProviderDocument = require('../models/ProviderDocument');
const { deleteFile } = require('../config/cloudinary');

// @desc    Submit provider personal info and documents (Onboarding Step 1)
// @route   POST /api/providers/personal-info
// @access  Private (Provider)
// ✅ NEW: Unified endpoint for provider profile and document submission
const submitPersonalInfo = asyncHandler(async (req, res) => {
  try {
    const providerId = req.user.id;
    const {
      providerType,
      providerSubType,
      fullName,
      email,
      phoneNumber,
      specialty,
      profession,
      experience,
      rate,
      briefDescription,
      city,
      idNumber,
      category,
      businessName,
    } = req.body;

    // Validate required fields
    if (!providerType || !fullName || !email || !phoneNumber || !city || !idNumber) {
      res.status(400);
      throw new Error('Missing required fields: providerType, fullName, email, phoneNumber, city, idNumber');
    }

    // Find existing provider
    let provider = await Provider.findById(providerId);
    if (!provider) {
      res.status(404);
      throw new Error('Provider not found');
    }

    // Update provider info
    provider.providerType = providerType;
    provider.providerSubType = providerSubType || null;
    provider.fullName = fullName;
    provider.email = email;
    provider.phoneNumber = phoneNumber;
    provider.specialty = specialty || null;
    provider.profession = profession || null;
    provider.experience = experience;
    provider.rate = rate;
    provider.briefDescription = briefDescription;
    provider.city = city;
    provider.idNumber = idNumber;
    provider.category = category || null;
    provider.businessName = businessName || null;

    // Handle document uploads via multer fields
    const documentMap = {
      medicalLicense: 'medicalLicense',
      degreeCertificate: 'degreeCertificate',
      professionalCertificate: 'professionalCertificate',
      businessLicense: 'businessLicense',
      nationalIdCard: 'nationalIdCard',
    };

    // Process uploaded documents
    if (req.files && Object.keys(req.files).length > 0) {
      for (const [fieldName, documentType] of Object.entries(documentMap)) {
        if (req.files[fieldName]?.[0]) {
          const file = req.files[fieldName][0];

          // Delete old document if exists
          const oldDoc = await ProviderDocument.findOne({
            providerId,
            documentType,
          });

          if (oldDoc?.publicId) {
            try {
              await deleteFile(oldDoc.publicId);
            } catch (error) {
              console.error(`Error deleting old ${documentType}:`, error.message);
            }
          }

          // Create new document record
          const providerDoc = await ProviderDocument.findOneAndUpdate(
            { providerId, documentType },
            {
              providerId,
              documentType,
              fileName: file.originalname,
              fileUrl: file.path,
              fileSize: file.size,
              mimeType: file.mimetype,
              publicId: file.filename,
              uploadedAt: Date.now(),
              verified: false,
            },
            { upsert: true, new: true }
          );

          console.log(`✅ Document uploaded: ${documentType}`, {
            fileName: file.originalname,
            fileUrl: file.path,
          });
        }
      }
    }

    // Check if nationalIdCard is uploaded (required)
    const nationalIdExists = await ProviderDocument.findOne({
      providerId,
      documentType: 'nationalIdCard',
    });

    if (!nationalIdExists) {
      res.status(400);
      throw new Error('National ID Card is required');
    }

    // Mark onboarding step complete and update onboarding status to pending_approval
    provider.onboardingStep = 1;
    provider.onboardingStatus = 'pending_approval'; // Two-phase auth: awaiting admin approval
    provider.verificationStatus = 'pending';
    await provider.save();

    // Get all uploaded documents
    const documents = await ProviderDocument.find({ providerId }).select('-__v');

    console.log(`✅ Provider personal info submitted: ${provider.email}`, {
      providerType,
      documentsCount: documents.length,
      verificationStatus: provider.verificationStatus,
    });

    res.json({
      success: true,
      message: 'Profile submitted for review. Admin will review your documents and contact you within 24 hours.',
      provider: {
        id: provider._id,
        fullName: provider.fullName,
        email: provider.email,
        providerType: provider.providerType,
        verificationStatus: provider.verificationStatus,
        onboardingStep: provider.onboardingStep,
      },
      documents: documents.map((doc) => ({
        id: doc._id,
        documentType: doc.documentType,
        fileName: doc.fileName,
        uploadedAt: doc.uploadedAt,
        verified: doc.verified,
      })),
    });
  } catch (error) {
    console.error('❌ Error submitting personal info:', error.message);
    throw error;
  }
});

// @desc    Get provider profile
// @route   GET /api/providers/profile
// @access  Private (Provider)
const getProviderProfile = asyncHandler(async (req, res) => {
  const provider = await Provider.findById(req.user.id);

  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }

  res.json({
    success: true,
    provider,
  });
});

// @desc    Update provider profile
// @route   PUT /api/providers/profile
// @access  Private (Provider)
const updateProviderProfile = asyncHandler(async (req, res) => {
  const provider = await Provider.findById(req.user.id);

  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }

  // Fields that can be updated after verification
  const allowedUpdates = [
    'fullName',
    'phoneNumber',
    'briefDescription',
    'rate',
    'serviceAreas',
    'availability',
    'address',
  ];

  // Only allow certain updates if not verified yet
  if (provider.verificationStatus !== 'approved') {
    allowedUpdates.push('experience', 'city');
  }

  allowedUpdates.forEach((field) => {
    if (req.body[field] !== undefined) {
      provider[field] = req.body[field];
    }
  });

  await provider.save();

  res.json({
    success: true,
    message: 'Profile updated successfully',
    provider,
  });
});

// @desc    Upload provider document
// @route   POST /api/providers/upload-document
// @access  Private (Provider)
const uploadDocument = asyncHandler(async (req, res) => {
  const { documentType } = req.body;
  const provider = await Provider.findById(req.user.id);

  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }

  if (!req.file) {
    res.status(400);
    throw new Error('Please upload a file');
  }

  const validDocTypes = [
    'medicalLicense',
    'degreeCertificate',
    'professionalCertificate',
    'businessLicense',
    'nationalIdCard',
  ];

  if (!validDocTypes.includes(documentType)) {
    res.status(400);
    throw new Error('Invalid document type');
  }

  // Delete old document if exists
  if (provider.documents[documentType]?.publicId) {
    try {
      await deleteFile(provider.documents[documentType].publicId);
    } catch (error) {
      console.error('Error deleting old document:', error);
    }
  }

  // Save new document info
  provider.documents[documentType] = {
    name: req.file.originalname,
    url: req.file.path,
    publicId: req.file.filename,
    uploadedAt: Date.now(),
    verified: false,
  };

  // Check if all documents are complete
  const docsComplete = provider.checkDocumentsComplete();
  if (docsComplete) {
    provider.onboardingStep = 3;
    provider.profileComplete = true;
    provider.verificationStatus = 'pending';
  }

  await provider.save();

  res.json({
    success: true,
    message: 'Document uploaded successfully',
    documentType,
    documentsComplete: docsComplete,
    profileComplete: provider.profileComplete,
  });
});

// @desc    Get provider verification status
// @route   GET /api/providers/verification
// @access  Private (Provider)
const getVerificationStatus = asyncHandler(async (req, res) => {
  const provider = await Provider.findById(req.user.id).select(
    'verificationStatus isVerified rejectionReason onboardingStep'
  );

  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }

  // Fetch documents for this provider
  const documents = await ProviderDocument.find({
    providerId: provider._id,
  }).select('documentType verified verifiedAt rejectionReason');

  const documentStatus = documents.reduce((acc, doc) => {
    acc[doc.documentType] = {
      uploaded: true,
      verified: doc.verified,
      verifiedAt: doc.verifiedAt,
      rejectionReason: doc.rejectionReason,
    };
    return acc;
  }, {});

  res.json({
    success: true,
    verificationStatus: provider.verificationStatus,
    isVerified: provider.isVerified,
    rejectionReason: provider.rejectionReason,
    onboardingStep: provider.onboardingStep,
    documentsCount: documents.length,
    documentsVerified: documents.filter((d) => d.verified).length,
    documents: documentStatus,
  });
});

// @desc    Update provider availability
// @route   PUT /api/providers/availability
// @access  Private (Provider)
const updateAvailability = asyncHandler(async (req, res) => {
  const provider = await Provider.findById(req.user.id);

  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }

  const { availability } = req.body;

  if (availability) {
    provider.availability = availability;
  }

  await provider.save();

  res.json({
    success: true,
    message: 'Availability updated successfully',
    availability: provider.availability,
  });
});

// PUBLIC ENDPOINTS

// @desc    Get all providers
// @route   GET /api/providers
// @access  Public
const getProviders = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  const query = {
    isActive: true,
    verificationStatus: 'approved',
  };

  // Filter by type
  if (req.query.type) {
    query.providerType = req.query.type;
  }

  // Filter by subtype
  if (req.query.subType) {
    query.providerSubType = req.query.subType;
  }

  // Filter by city
  if (req.query.city) {
    query.city = req.query.city;
  }

  // Filter by specialty (doctors)
  if (req.query.specialty) {
    query.specialty = req.query.specialty;
  }

  // Filter by category (vendors)
  if (req.query.category) {
    query.category = req.query.category;
  }

  // Sort
  let sort = {};
  if (req.query.sort === 'rating') {
    sort = { 'ratings.average': -1 };
  } else {
    sort = { createdAt: -1 };
  }

  const total = await Provider.countDocuments(query);
  const providers = await Provider.find(query)
    .select('-documents -refreshToken')
    .sort(sort)
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

// @desc    Search providers
// @route   GET /api/providers/search
// @access  Public
const searchProviders = asyncHandler(async (req, res) => {
  const { q, type, city, minRating, maxRate } = req.query;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  const query = {
    isActive: true,
    verificationStatus: 'approved',
  };

  // Text search
  if (q) {
    query.$or = [
      { fullName: { $regex: q, $options: 'i' } },
      { briefDescription: { $regex: q, $options: 'i' } },
      { specialty: { $regex: q, $options: 'i' } },
      { profession: { $regex: q, $options: 'i' } },
      { businessName: { $regex: q, $options: 'i' } },
      { professionalName: { $regex: q, $options: 'i' } },
    ];
  }

  if (type) query.providerType = type;
  if (city) query.city = city;
  if (minRating) query['ratings.average'] = { $gte: parseFloat(minRating) };
  if (maxRate) query.rate = { $lte: maxRate };

  const total = await Provider.countDocuments(query);
  const providers = await Provider.find(query)
    .select('-documents -refreshToken')
    .sort({ 'ratings.average': -1 })
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

// @desc    Get provider by ID
// @route   GET /api/providers/:id
// @access  Public
const getProviderById = asyncHandler(async (req, res) => {
  const provider = await Provider.findById(req.params.id)
    .select('-documents -refreshToken')
    .populate('reviews.user', 'fullName profilePhoto');

  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }

  if (!provider.isActive || provider.verificationStatus !== 'approved') {
    res.status(404);
    throw new Error('Provider not available');
  }

  res.json({
    success: true,
    provider,
  });
});

// @desc    Rate a provider
// @route   POST /api/providers/:id/rate
// @access  Private (User)
const rateProvider = asyncHandler(async (req, res) => {
  const { rating, review } = req.body;
  const providerId = req.params.id;
  const userId = req.user.id;

  if (!rating || rating < 1 || rating > 5) {
    res.status(400);
    throw new Error('Rating must be between 1 and 5');
  }

  const provider = await Provider.findById(providerId);

  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }

  // Check if user already rated
  const existingReview = provider.reviews.find(
    (r) => r.user.toString() === userId
  );

  if (existingReview) {
    res.status(400);
    throw new Error('You have already rated this provider');
  }

  // Add review
  provider.reviews.push({
    user: userId,
    rating,
    comment: review,
  });

  // Update rating
  provider.updateRating(rating);

  await provider.save();

  res.json({
    success: true,
    message: 'Rating submitted successfully',
    ratings: provider.ratings,
  });
});

// @desc    Get providers by type
// @route   GET /api/providers/by-type/:type
// @access  Public
const getProvidersByType = asyncHandler(async (req, res) => {
  const { type } = req.params;
  const { subType } = req.query;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  const query = {
    providerType: type,
    isActive: true,
    verificationStatus: 'approved',
  };

  if (subType) {
    query.providerSubType = subType;
  }

  const total = await Provider.countDocuments(query);
  const providers = await Provider.find(query)
    .select('-documents -refreshToken')
    .sort({ 'ratings.average': -1 })
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

// @desc    Update provider profile with documents (After email verification)
// @route   PUT /api/provider/profile
// @access  Private (Provider with JWT) - REQUIRED
// ✅ UPDATED: Match frontend requirements exactly
const updateProviderProfileComplete = asyncHandler(async (req, res) => {
  // ✅ REQUIRE authentication - frontend sends JWT token
  const providerId = req.user?.id;
  
  if (!providerId) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required',
      error: 'UNAUTHORIZED'
    });
  }

  const {
    providerType,
    providerSubType,
    fullName,
    phoneNumber,
    city,
    address,
    specialty,
    profession,
    category,
    experience,
    yearsOfExperience,
    idNumber,
    bio,
    briefDescription,
    professionalName,
    businessName,
    rate,
  } = req.body;

  // Find provider
  const provider = await Provider.findById(providerId);
  if (!provider) {
    return res.status(404).json({
      success: false,
      message: 'Provider not found',
      error: 'PROVIDER_NOT_FOUND'
    });
  }

  // Check email verification
  if (provider.emailVerified !== 'active') {
    return res.status(403).json({
      success: false,
      message: 'Please verify your email first',
      error: 'EMAIL_NOT_VERIFIED',
      emailVerified: provider.emailVerified
    });
  }

  // Update profile fields
  if (providerType) provider.providerType = providerType;
  if (providerSubType) provider.providerSubType = providerSubType;
  if (fullName) provider.fullName = fullName;
  if (phoneNumber) provider.phoneNumber = phoneNumber;
  if (city) provider.city = city;
  if (address) provider.address = typeof address === 'string' ? JSON.parse(address) : address;
  if (specialty) provider.specialty = specialty;
  if (profession) provider.profession = profession;
  if (category) provider.category = category;
  if (experience) provider.experience = experience;
  if (yearsOfExperience) provider.experience = yearsOfExperience;
  if (idNumber) provider.idNumber = idNumber;
  if (bio) provider.briefDescription = bio;
  if (briefDescription) provider.briefDescription = briefDescription;
  if (professionalName) provider.professionalName = professionalName;
  if (businessName) provider.businessName = businessName;
  if (rate) provider.rate = rate;

  // Handle document uploads
  const documents = {};
  if (req.files) {
    const fileFields = ['medicalLicense', 'degreeCertificate', 'nationalIdCard', 'professionalCertificate', 'businessLicense', 'insuranceDocument', 'profilePhoto'];
    
    fileFields.forEach(field => {
      if (req.files[field] && req.files[field][0]) {
        const file = req.files[field][0];
        documents[field] = {
          url: file.path,
          key: file.filename,
          uploadedAt: new Date()
        };
        
        // Store in provider documents field
        if (!provider.documents) provider.documents = {};
        provider.documents[field] = {
          url: file.path,
          publicId: file.filename,
          name: file.originalname,
          uploadedAt: new Date(),
          verified: false
        };
      }
    });
  }

  // ✅ Update status to pending_approval after profile completion
  provider.onboardingStatus = 'pending_approval';
  provider.profileComplete = true;
  provider.submittedAt = new Date();
  
  await provider.save();

  // Send notification to admin
  try {
    const { sendEmail } = require('../services/emailService');
    await sendEmail({
      email: process.env.ADMIN_EMAIL || 'admin@metromatrix.com',
      subject: 'New Provider Profile Submitted - Review Required',
      html: `
        <h2>Provider Profile Submitted</h2>
        <p><strong>Name:</strong> ${provider.fullName}</p>
        <p><strong>Email:</strong> ${provider.email}</p>
        <p><strong>Type:</strong> ${provider.providerType}</p>
        <p><strong>City:</strong> ${provider.city}</p>
        <p>Please review this provider's profile in the admin dashboard.</p>
      `,
    });
  } catch (emailError) {
    console.error('Error sending admin notification:', emailError);
  }

  res.json({
    success: true,
    message: 'Profile updated and submitted for admin approval',
    provider: {
      _id: provider._id,
      email: provider.email,
      fullName: provider.fullName,
      emailVerified: 'active', // ✅ New flag
      adminVerified: 'pending', // ✅ New flag
      status: 'pending_approval',
      city: provider.city,
      providerType: provider.providerType,
      documents,
      submittedAt: provider.submittedAt,
      updatedAt: provider.updatedAt
    },
    submissionId: provider._id,
  });
});

// @desc    Check provider approval status
// @route   GET /api/provider/approval-status
// @access  Public
// ✅ UPDATED: Match frontend requirements exactly
const checkApprovalStatus = asyncHandler(async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({
      success: false,
      message: 'Email is required',
      error: 'MISSING_EMAIL'
    });
  }

  const provider = await Provider.findOne({ email })
    .populate('verifiedBy', 'fullName')
    .select('-password -refreshToken');

  if (!provider) {
    return res.status(404).json({
      success: false,
      message: 'Provider not found with this email',
      error: 'PROVIDER_NOT_FOUND'
    });
  }

  // Determine status based on new flags
  let status = 'pending_approval';
  let message = 'Your application is under review by our admin team.';

  if (provider.adminVerified === 'active') {
    status = 'approved';
    message = 'Your account has been approved! You can now sign in.';
  } else if (provider.adminVerified === 'inactive') {
    status = 'rejected';
    message = 'Your application was not approved.';
  } else if (provider.emailVerified === 'pending') {
    status = 'pending_email';
    message = 'Please verify your email first.';
  } else if (provider.emailVerified === 'active' && !provider.profileComplete) {
    status = 'email_verified';
    message = 'Please complete your profile.';
  } else if (provider.adminVerified === 'pending') {
    status = 'pending_approval';
    message = 'Your application is under review by our admin team.';
  }

  const response = {
    success: true,
    status,
    message,
    provider: {
      _id: provider._id,
      fullName: provider.fullName,
      email: provider.email,
      providerType: provider.providerType,
      emailVerified: provider.emailVerified, // ✅ New flag
      adminVerified: provider.adminVerified, // ✅ New flag
    }
  };

  // Add additional details based on status
  if (status === 'approved') {
    response.approvedAt = provider.approvedAt;
    if (provider.verifiedBy) {
      response.approvedBy = {
        adminId: provider.verifiedBy._id,
        adminName: provider.verifiedBy.fullName
      };
    }
  } else if (status === 'rejected') {
    response.rejectionReason = provider.rejectionReason || 'No reason provided';
    response.rejectedAt = provider.rejectedAt;
    if (provider.verifiedBy) {
      response.rejectedBy = {
        adminId: provider.verifiedBy._id,
        adminName: provider.verifiedBy.fullName
      };
    }
  } else if (status === 'pending_approval') {
    response.submittedAt = provider.submittedAt;
  }

  res.json(response);
});

module.exports = {
  getProviderProfile,
  updateProviderProfile,
  submitPersonalInfo,
  uploadDocument,
  getVerificationStatus,
  updateAvailability,
  getProviders,
  searchProviders,
  getProviderById,
  rateProvider,
  getProvidersByType,
  updateProviderProfileComplete, // ✅ NEW
  checkApprovalStatus, // ✅ NEW
};