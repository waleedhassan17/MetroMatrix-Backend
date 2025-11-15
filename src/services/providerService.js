const Provider = require('../models/Provider');
const { deleteFile } = require('../config/cloudinary');

class ProviderService {
  // Get provider with sanitized data
  static async getProviderData(providerId) {
    const provider = await Provider.findById(providerId).select('-password -refreshToken -resetPasswordToken');
    if (!provider) {
      throw new Error('Provider not found');
    }
    return provider.toJSON();
  }

  // Update provider profile
  static async updateProfile(providerId, updateData) {
    const provider = await Provider.findById(providerId);

    if (!provider) {
      throw new Error('Provider not found');
    }

    // Allowed updates after verification
    let allowedUpdates = [
      'fullName',
      'phoneNumber',
      'briefDescription',
      'rate',
      'serviceAreas',
      'availability',
      'address',
    ];

    // Allow more updates if not verified
    if (provider.verificationStatus !== 'approved') {
      allowedUpdates.push('experience', 'city');
    }

    allowedUpdates.forEach((field) => {
      if (updateData[field] !== undefined) {
        provider[field] = updateData[field];
      }
    });

    await provider.save();

    return provider.toJSON();
  }

  // Submit personal information
  static async submitPersonalInfo(providerId, infoData) {
    const provider = await Provider.findById(providerId);

    if (!provider) {
      throw new Error('Provider not found');
    }

    if (provider.verificationStatus === 'approved') {
      throw new Error('Provider is already verified');
    }

    const { providerType, providerSubType, specialty, profession, category, experience, briefDescription, rate, professionalName, businessName, city, idNumber } = infoData;

    // Validate provider type
    if (!providerType || !['doctor', 'home_service', 'vendor'].includes(providerType)) {
      throw new Error('Invalid provider type');
    }

    provider.providerType = providerType;

    // Type-specific validation
    if (providerType === 'doctor') {
      if (!specialty) {
        throw new Error('Specialty is required for doctors');
      }
      provider.specialty = specialty;
      provider.professionalName = professionalName;
    } else if (providerType === 'home_service') {
      if (!providerSubType) {
        throw new Error('Service type is required');
      }
      provider.providerSubType = providerSubType;
      provider.profession = profession || providerSubType;
    } else if (providerType === 'vendor') {
      if (!category) {
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
    provider.onboardingStep = Math.max(provider.onboardingStep, 2);

    await provider.save();

    return {
      id: provider._id,
      providerType: provider.providerType,
      onboardingStep: provider.onboardingStep,
    };
  }

  // Upload document
  static async uploadDocument(providerId, documentType, fileData) {
    const provider = await Provider.findById(providerId);

    if (!provider) {
      throw new Error('Provider not found');
    }

    const validDocTypes = [
      'medicalLicense',
      'degreeCertificate',
      'professionalCertificate',
      'businessLicense',
      'nationalIdCard',
    ];

    if (!validDocTypes.includes(documentType)) {
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

    // Save new document
    provider.documents[documentType] = {
      name: fileData.originalname || fileData.filename,
      url: fileData.path,
      publicId: fileData.filename,
      uploadedAt: new Date(),
      verified: false,
    };

    // Check if all required documents are uploaded
    const docsComplete = provider.checkDocumentsComplete();
    if (docsComplete) {
      provider.onboardingStep = 3;
      provider.profileComplete = true;
      provider.verificationStatus = 'pending';
    }

    await provider.save();

    return {
      documentType,
      uploaded: true,
      documentsComplete: docsComplete,
      profileComplete: provider.profileComplete,
    };
  }

  // Get verification status
  static async getVerificationStatus(providerId) {
    const provider = await Provider.findById(providerId).select(
      'verificationStatus isVerified rejectionReason documents profileComplete'
    );

    if (!provider) {
      throw new Error('Provider not found');
    }

    const documentStatus = Object.keys(provider.documents).reduce((acc, key) => {
      if (provider.documents[key]?.url) {
        acc[key] = {
          uploaded: true,
          verified: provider.documents[key].verified,
        };
      }
      return acc;
    }, {});

    return {
      verificationStatus: provider.verificationStatus,
      isVerified: provider.isVerified,
      rejectionReason: provider.rejectionReason,
      profileComplete: provider.profileComplete,
      documents: documentStatus,
    };
  }

  // Search providers
  static async searchProviders(filters, page = 1, limit = 10) {
    const skip = (page - 1) * limit;

    const query = {
      isActive: true,
      verificationStatus: 'approved',
    };

    // Text search
    if (filters.q) {
      query.$or = [
        { fullName: { $regex: filters.q, $options: 'i' } },
        { briefDescription: { $regex: filters.q, $options: 'i' } },
        { specialty: { $regex: filters.q, $options: 'i' } },
        { profession: { $regex: filters.q, $options: 'i' } },
        { businessName: { $regex: filters.q, $options: 'i' } },
        { professionalName: { $regex: filters.q, $options: 'i' } },
      ];
    }

    if (filters.type) query.providerType = filters.type;
    if (filters.city) query.city = filters.city;
    if (filters.minRating) query['ratings.average'] = { $gte: parseFloat(filters.minRating) };
    if (filters.maxRate) query.rate = { $lte: filters.maxRate };
    if (filters.category) query.category = filters.category;
    if (filters.specialty) query.specialty = filters.specialty;

    const total = await Provider.countDocuments(query);
    const providers = await Provider.find(query)
      .select('-documents -refreshToken -password')
      .sort({ 'ratings.average': -1 })
      .limit(limit)
      .skip(skip);

    return {
      providers: providers.map((p) => p.toJSON()),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Get providers by type
  static async getProvidersByType(type, subType = null, page = 1, limit = 10) {
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
      .select('-documents -refreshToken -password')
      .sort({ 'ratings.average': -1 })
      .limit(limit)
      .skip(skip);

    return {
      providers: providers.map((p) => p.toJSON()),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Update availability
  static async updateAvailability(providerId, availability) {
    const provider = await Provider.findById(providerId);

    if (!provider) {
      throw new Error('Provider not found');
    }

    provider.availability = availability;
    await provider.save();

    return provider.availability;
  }

  // Add rating/review
  static async addRating(providerId, userId, rating, comment = '') {
    const provider = await Provider.findById(providerId);

    if (!provider) {
      throw new Error('Provider not found');
    }

    // Check if user already rated
    const alreadyRated = provider.reviews.some((r) => r.user.toString() === userId);

    if (alreadyRated) {
      throw new Error('You have already rated this provider');
    }

    if (rating < 1 || rating > 5) {
      throw new Error('Rating must be between 1 and 5');
    }

    // Add review
    provider.reviews.push({
      user: userId,
      rating,
      comment,
    });

    // Update rating
    provider.updateRating(rating);
    await provider.save();

    return {
      ratings: provider.ratings,
      message: 'Rating submitted successfully',
    };
  }

  // Get provider statistics
  static async getProviderStats(providerId) {
    const provider = await Provider.findById(providerId);

    if (!provider) {
      throw new Error('Provider not found');
    }

    return {
      totalBookings: provider.totalBookings,
      completedBookings: provider.completedBookings,
      cancelledBookings: provider.cancelledBookings,
      ratings: provider.ratings,
      reviewCount: provider.reviews.length,
      verificationStatus: provider.verificationStatus,
      isVerified: provider.isVerified,
      createdAt: provider.createdAt,
      approvedAt: provider.approvedAt,
    };
  }

  // Approve provider (admin)
  static async approveProvider(providerId, approvingAdmin) {
    const provider = await Provider.findById(providerId);

    if (!provider) {
      throw new Error('Provider not found');
    }

    provider.verificationStatus = 'approved';
    provider.isVerified = true;
    provider.verifiedBy = approvingAdmin;
    provider.approvedAt = new Date();

    await provider.save();

    return { success: true, message: 'Provider approved successfully' };
  }

  // Reject provider (admin)
  static async rejectProvider(providerId, reason, approvingAdmin) {
    const provider = await Provider.findById(providerId);

    if (!provider) {
      throw new Error('Provider not found');
    }

    provider.verificationStatus = 'rejected';
    provider.rejectionReason = reason;
    provider.verifiedBy = approvingAdmin;

    await provider.save();

    return { success: true, message: 'Provider rejected successfully' };
  }
}

module.exports = ProviderService;