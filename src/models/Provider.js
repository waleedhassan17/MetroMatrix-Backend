const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const providerSchema = new mongoose.Schema(
  {
    // Basic Information
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      match: [
        /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/,
        'Please provide a valid email',
      ],
    },
    password: {
      type: String,
      required: function () {
        return !this.googleId && !this.facebookId;
      },
      minlength: 6,
      select: false,
    },
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    phoneNumber: {
      type: String,
      required: true,
      match: [/^[0-9]{10,15}$/, 'Please provide a valid phone number'],
    },
    profilePhoto: {
      type: String,
    },
    profilePhotoId: {
      type: String,
    },

    // Provider Type Information
    providerType: {
      type: String,
      enum: ['doctor', 'home_service', 'vendor', 'pending'],
      required: true,
      default: 'pending',
    },
    providerSubType: {
      type: String,
      enum: ['electrician', 'plumber', 'ac_repairer', null],
    },

    // Professional Information
    specialty: String, // For doctors
    profession: String, // For home service
    category: String, // For vendors
    experience: {
      type: String,
    },
    briefDescription: {
      type: String,
      maxlength: 500,
    },
    rate: String,
    consultationFee: {
      type: Number,
      default: 0,
    },

    // Business Information
    professionalName: String, // For doctors - clinic name
    businessName: String, // For vendors

    // Location
    city: {
      type: String,
    },
    serviceAreas: [String], // Areas where provider offers services
    address: {
      street: String,
      city: String,
      postalCode: String,
      country: {
        type: String,
        default: 'Pakistan',
      },
    },

    // Identification
    idNumber: {
      type: String,
    },

    // Documents
    documents: {
      medicalLicense: {
        name: String,
        url: String,
        publicId: String,
        uploadedAt: Date,
        verified: {
          type: Boolean,
          default: false,
        },
      },
      degreeCertificate: {
        name: String,
        url: String,
        publicId: String,
        uploadedAt: Date,
        verified: {
          type: Boolean,
          default: false,
        },
      },
      professionalCertificate: {
        name: String,
        url: String,
        publicId: String,
        uploadedAt: Date,
        verified: {
          type: Boolean,
          default: false,
        },
      },
      businessLicense: {
        name: String,
        url: String,
        publicId: String,
        uploadedAt: Date,
        verified: {
          type: Boolean,
          default: false,
        },
      },
      nationalIdCard: {
        name: String,
        url: String,
        publicId: String,
        uploadedAt: Date,
        verified: {
          type: Boolean,
          default: false,
        },
      },
    },

    // Social Login
    googleId: String,
    facebookId: String,

    // Status & Onboarding (Updated Flow - Mirrors User Flow)
    status: {
      type: String,
      enum: [
        'pending_email_verification',  // Just signed up
        'email_verified',              // Email verified, profile not submitted
        'pending_review',              // Profile submitted, waiting for admin
        'approved',                    // Admin approved
        'rejected'                     // Admin rejected
      ],
      default: 'pending_email_verification',
    },
    onboardingStatus: {
      type: String,
      enum: ['pending_email', 'pending_documents', 'pending_approval', 'approved', 'rejected'],
      default: 'pending_email',
      // pending_email: Email not verified yet (stored in PendingSignup)
      // pending_documents: Email verified, account created, needs to upload documents
      // pending_approval: Documents submitted, awaiting admin review (isVerified=false)
      // approved: Admin approved, can login (isVerified=true)
      // rejected: Admin rejected, can resubmit documents
    },
    profileComplete: {
      type: Boolean,
      default: false,
    },
    onboardingStep: {
      type: Number,
      default: 0,
      min: 0,
      max: 3,
    },
    isVerified: {
      type: Boolean,
      default: false,
      // CRITICAL: Provider can only login when isVerified=true (set by admin approval)
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // ✅ UPDATED: Use 'pending', 'active', 'inactive' flags
    emailVerified: {
      type: String,
      enum: ['pending', 'active', 'inactive'],
      default: 'pending',
      // pending: Email not verified yet
      // active: Email verified
      // inactive: Email verification failed/revoked
    },
    adminVerified: {
      type: String,
      enum: ['pending', 'active', 'inactive'],
      default: 'pending',
      // pending: Awaiting admin approval
      // active: Admin approved (can login)
      // inactive: Admin rejected (cannot login)
    },
    emailVerificationToken: String,
    emailVerificationExpire: Date,
    emailVerificationSentAt: Date,
    emailVerificationAttempts: {
      type: Number,
      default: 0,
    },
    rejectionReason: String,
    adminNotes: String,
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
    },
    rejectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
    },
    approvedAt: Date,
    rejectedAt: Date,
    submittedAt: Date, // When profile was submitted for review
    
    // Legacy fields (kept for backward compatibility)
    verificationStatus: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    canLogin: {
      type: Boolean,
      default: false,
    },
    
    // Online Status
    isOnline: {
      type: Boolean,
      default: false,
    },
    lastSeen: {
      type: Date,
    },

    // Availability
    availability: {
      monday: { start: String, end: String, isAvailable: Boolean },
      tuesday: { start: String, end: String, isAvailable: Boolean },
      wednesday: { start: String, end: String, isAvailable: Boolean },
      thursday: { start: String, end: String, isAvailable: Boolean },
      friday: { start: String, end: String, isAvailable: Boolean },
      saturday: { start: String, end: String, isAvailable: Boolean },
      sunday: { start: String, end: String, isAvailable: Boolean },
    },

    // Ratings
    ratings: {
      average: {
        type: Number,
        default: 0,
        min: 0,
        max: 5,
      },
      count: {
        type: Number,
        default: 0,
      },
      breakdown: {
        1: { type: Number, default: 0 },
        2: { type: Number, default: 0 },
        3: { type: Number, default: 0 },
        4: { type: Number, default: 0 },
        5: { type: Number, default: 0 },
      },
    },

    // Reviews
    reviews: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
        rating: {
          type: Number,
          required: true,
          min: 1,
          max: 5,
        },
        comment: String,
        createdAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],

    // Stats
    totalBookings: {
      type: Number,
      default: 0,
    },
    completedBookings: {
      type: Number,
      default: 0,
    },
    cancelledBookings: {
      type: Number,
      default: 0,
    },

    // Authentication
    lastLoginDate: Date,
    refreshToken: String,
    resetPasswordToken: String,
    resetPasswordExpire: Date,
    approvedAt: Date,

    // Stripe Connect (for wallet payouts to bank)
    stripeConnectAccountId: { type: String, sparse: true, index: true },
    stripeConnectStatus: {
      type: String,
      enum: ['not_started', 'pending', 'active', 'restricted'],
      default: 'not_started',
    },
    stripeChargesEnabled: { type: Boolean, default: false },
    stripePayoutsEnabled: { type: Boolean, default: false },
    stripeDetailsSubmitted: { type: Boolean, default: false },
  },
  {
    timestamps: true,
  }
);

// Indexes
providerSchema.index({ email: 1 });
providerSchema.index({ providerType: 1 });
providerSchema.index({ city: 1 });
providerSchema.index({ 'ratings.average': -1 });
providerSchema.index({ verificationStatus: 1 });
providerSchema.index({ status: 1 });
providerSchema.index({ emailVerified: 1 });
providerSchema.index({ adminVerified: 1 });
providerSchema.index({ onboardingStatus: 1 });

// Track if document is new for post-save hook
providerSchema.pre('save', function (next) {
  this.wasNew = this.isNew;
  next();
});

// Hash password before saving
providerSchema.pre('save', async function (next) {
  if (!this.isModified('password')) {
    next();
  }

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Create wallet for new providers
providerSchema.post('save', async function (doc, next) {
  if (doc.wasNew) {
    const Wallet = require('./Wallet');
    await Wallet.findOneAndUpdate(
      { owner: doc._id, ownerType: 'Provider' },
      { $setOnInsert: { owner: doc._id, ownerType: 'Provider', balance: 0 } },
      { upsert: true, new: true }
    );
  }
  next();
});

// Match passwords
providerSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// Check if all required documents are uploaded
providerSchema.methods.checkDocumentsComplete = function () {
  const requiredDocs = {
    doctor: ['medicalLicense', 'degreeCertificate', 'nationalIdCard'],
    home_service: ['professionalCertificate', 'nationalIdCard'],
    vendor: ['businessLicense', 'nationalIdCard'],
  };

  if (this.providerType === 'pending') {
    return false;
  }

  const required = requiredDocs[this.providerType];
  return required.every((doc) => this.documents[doc] && this.documents[doc].url);
};

// Update rating
providerSchema.methods.updateRating = function (newRating) {
  const currentTotal = this.ratings.average * this.ratings.count;
  this.ratings.count += 1;
  this.ratings.average = (currentTotal + newRating) / this.ratings.count;
  this.ratings.breakdown[newRating] += 1;
};

// Generate reset password token
providerSchema.methods.getResetPasswordToken = function () {
  const resetToken = crypto.randomBytes(20).toString('hex');

  this.resetPasswordToken = crypto
    .createHash('sha256')
    .update(resetToken)
    .digest('hex');

  this.resetPasswordExpire = Date.now() + 10 * 60 * 1000; // 10 minutes

  return resetToken;
};

// Sanitize provider data for response
providerSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.refreshToken;
  delete obj.resetPasswordToken;
  delete obj.resetPasswordExpire;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Provider', providerSchema);