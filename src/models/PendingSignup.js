const mongoose = require('mongoose');

const pendingSignupSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
    },
    phoneNumber: {
      type: String,
      required: true,
    },
    password: {
      type: String,
      required: true,
      select: false,
    },
    verificationToken: {
      type: String,
      required: true,
    },
    verificationTokenExpire: {
      type: Date,
      required: true,
    },
    userType: {
      type: String,
      enum: ['user', 'provider'],
      required: true,
      default: 'user',
    },
    // For providers only
    providerType: String,
    providerSubType: String,
    city: String,
    
    // Metadata
    createdAt: {
      type: Date,
      default: Date.now,
      expires: 86400, // Auto-delete after 24 hours
    },
  },
  { timestamps: true }
);

// Ensure token expires after 24 hours and document auto-deletes
pendingSignupSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.model('PendingSignup', pendingSignupSchema);
