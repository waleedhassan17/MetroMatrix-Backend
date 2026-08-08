const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { hashPasswordPreSave } = require('../utils/hashPassword');

const userSchema = new mongoose.Schema(
  {
    // Basic Information
    email: {
      type: String,
      required: [true, 'Please provide an email'],
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
      required: [true, 'Please provide your full name'],
      trim: true,
    },
    phoneNumber: {
      type: String,
      // Google/Facebook never give us a phone number. This used to be
      // unconditionally required, so creating a social account threw a
      // ValidationError and every brand-new Google/Facebook sign-in 500'd.
      // The app collects the number during profile completion instead.
      required: [
        function () {
          return !this.googleId && !this.facebookId;
        },
        'Please provide a phone number',
      ],
      validate: {
        // Only shape-check a number that's actually present — an absent one
        // is the social case handled by `required` above.
        validator: (value) => value == null || value === '' || /^[0-9]{10,15}$/.test(value),
        message: 'Please provide a valid phone number',
      },
    },

    // Profile Information
    dateOfBirth: {
      type: Date,
    },
    gender: {
      type: String,
      enum: ['male', 'female', 'other'],
    },
    profilePhoto: {
      type: String,
      default: null,
    },
    profilePhotoId: {
      type: String, // Cloudinary public ID for deletion
    },

    // Address Information
    address: {
      street: String,
      city: String,
      postalCode: String,
      country: {
        type: String,
        default: 'Pakistan',
      },
    },

    // Social Login
    googleId: String,
    facebookId: String,

    // Account Status
    profileComplete: {
      type: Boolean,
      default: false,
    },
    profileCompletionStep: {
      type: Number,
      default: 0,
      min: 0,
      max: 3,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },

    emailVerified: {
  type: Boolean,
  default: false,
},
emailVerificationToken: String,
emailVerificationExpire: Date,
emailVerificationSentAt: Date,
emailVerificationAttempts: {
  type: Number,
  default: 0,
},


    // Authentication
    lastLoginDate: Date,
    refreshToken: String,
    resetPasswordToken: String,
    resetPasswordExpire: Date,
    emailVerificationToken: String,
    emailVerificationExpire: Date,

    // Preferences
    preferences: {
      notifications: {
        type: Boolean,
        default: true,
      },
      newsletter: {
        type: Boolean,
        default: false,
      },
      language: {
        type: String,
        default: 'en',
      },
      theme: {
        type: String,
        enum: ['light', 'dark', 'auto'],
        default: 'light',
      },
    },

    // Stats
    totalPosts: {
      type: Number,
      default: 0,
    },
    totalComments: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
userSchema.index({ email: 1 });
userSchema.index({ phoneNumber: 1 });
userSchema.index({ createdAt: -1 });

// Virtual for age
userSchema.virtual('age').get(function () {
  if (this.dateOfBirth) {
    const today = new Date();
    const birthDate = new Date(this.dateOfBirth);
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    
    return age;
  }
  return null;
});

// Track if document is new for post-save hook
userSchema.pre('save', function (next) {
  this.wasNew = this.isNew;
  next();
});

// Hash password before saving (shared hook — see utils/hashPassword.js for
// the double-hash bug it fixes)
userSchema.pre('save', hashPasswordPreSave);

// Create wallet for new users
userSchema.post('save', async function (doc, next) {
  if (doc.wasNew) {
    const Wallet = require('./Wallet');
    await Wallet.findOneAndUpdate(
      { owner: doc._id, ownerType: 'User' },
      { $setOnInsert: { owner: doc._id, ownerType: 'User', balance: 0 } },
      { upsert: true, new: true }
    );
  }
  next();
});

// Match passwords
userSchema.methods.matchPassword = async function (enteredPassword) {
  // A social-only account has no password, and a doc fetched without
  // `.select('+password')` has none loaded. bcrypt.compare throws on an
  // undefined hash, which surfaced as a 500 instead of a clean "wrong
  // credentials" — treat it as simply not matching.
  if (!this.password) return false;
  return await bcrypt.compare(enteredPassword, this.password);
};

// Generate reset password token
userSchema.methods.getResetPasswordToken = function () {
  const resetToken = crypto.randomBytes(20).toString('hex');

  // Hash token and set to resetPasswordToken field
  this.resetPasswordToken = crypto
    .createHash('sha256')
    .update(resetToken)
    .digest('hex');

  // Set expire
  this.resetPasswordExpire = Date.now() + 10 * 60 * 1000; // 10 minutes

  return resetToken;
};

// Generate email verification token
userSchema.methods.getEmailVerificationToken = function () {
  const verificationToken = crypto.randomBytes(20).toString('hex');

  this.emailVerificationToken = crypto
    .createHash('sha256')
    .update(verificationToken)
    .digest('hex');

  this.emailVerificationExpire = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

  return verificationToken;
};

// Check if profile is complete
userSchema.methods.checkProfileComplete = function () {
  const requiredFields = ['dateOfBirth', 'gender', 'address.city'];
  const isComplete = requiredFields.every((field) => {
    if (field.includes('.')) {
      const [parent, child] = field.split('.');
      return this[parent] && this[parent][child];
    }
    return this[field];
  });

  this.profileComplete = isComplete;
  return isComplete;
};

// Sanitize user data for response
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.refreshToken;
  delete obj.resetPasswordToken;
  delete obj.resetPasswordExpire;
  delete obj.emailVerificationToken;
  delete obj.emailVerificationExpire;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('User', userSchema);