const asyncHandler = require('express-async-handler');
const Provider = require('../models/Provider');
const { deleteFile } = require('../config/cloudinary');

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

// @desc    Submit provider personal info (multi-step onboarding)
// @route   POST /api/providers/personal-info
// @access  Private (Provider)
const submitPersonalInfo = asyncHandler(async (req, res) => {
  const provider = await Provider.findById(req.user.id);

  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }

  if (provider.verificationStatus === 'approved') {
    res.status(400);
    throw new Error('Provider is already verified');
  }

  const {
    providerType,
    providerSubType,
    specialty,
    profession,
    category,
    experience,
    briefDescription,
    rate,
    professionalName,
    businessName,
    city,
    idNumber,
  } = req.body;

  // Validate provider type
  if (!providerType || !['doctor', 'home_service', 'vendor'].includes(providerType)) {
    res.status(400);
    throw new Error('Invalid provider type');
  }

  // Update provider information
  provider.providerType = providerType;

  // Type-specific fields
  if (providerType === 'doctor') {
    if (!specialty) {
      res.status(400);
      throw new Error('Specialty is required for doctors');
    }
    provider.specialty = specialty;
    provider.professionalName = professionalName;
  } else if (providerType === 'home_service') {
    if (!providerSubType) {
      res.status(400);
      throw new Error('Service type is required');
    }
    provider.providerSubType = providerSubType;
    provider.profession = profession || providerSubType;
  } else if (providerType === 'vendor') {
    if (!category) {
      res.status(400);
      throw new Error('Category is required for vendors');
    }
    provider.category = category;
    provider.businessName = businessName;
  }

  // Common fields
  provider.experience = experience;
  provider.briefDescription = briefDescription;
  provider.city = city;
  provider.idNumber = idNumber;
  provider.rate = rate;

  // Update onboarding step
  provider.onboardingStep = Math.max(provider.onboardingStep, 2);

  await provider.save();

  res.json({
    success: true,
    message: 'Personal information submitted successfully',
    provider: {
      id: provider._id,
      providerType: provider.providerType,
      providerSubType: provider.providerSubType,
      onboardingStep: provider.onboardingStep,
      profileComplete: provider.profileComplete,
    },
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
    'verificationStatus isVerified rejectionReason documents profileComplete'
  );

  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }

  res.json({
    success: true,
    verificationStatus: provider.verificationStatus,
    isVerified: provider.isVerified,
    rejectionReason: provider.rejectionReason,
    profileComplete: provider.profileComplete,
    documents: Object.keys(provider.documents).reduce((acc, key) => {
      if (provider.documents[key]?.url) {
        acc[key] = {
          uploaded: true,
          verified: provider.documents[key].verified,
        };
      }
      return acc;
    }, {}),
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
};