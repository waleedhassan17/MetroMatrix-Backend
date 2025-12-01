const mongoose = require('mongoose');

const EmailVerificationSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    lowercase: true,
  },
  token: {
    type: String,
    required: true,
    unique: true,
  },
  userType: {
    type: String,
    enum: ['user', 'provider'],
    required: true,
  },
  verified: {
    type: Boolean,
    default: false,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 86400, // Auto-delete after 24 hours
  },
}, {
  timestamps: true,
});

// Index for faster queries
EmailVerificationSchema.index({ email: 1, userType: 1 });
EmailVerificationSchema.index({ token: 1 });
EmailVerificationSchema.index({ expiresAt: 1 });

module.exports = mongoose.model('EmailVerification', EmailVerificationSchema);
