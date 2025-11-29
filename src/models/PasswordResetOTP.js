const mongoose = require('mongoose');
const crypto = require('crypto');

const passwordResetOTPSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      index: true,
    },
    userType: {
      type: String,
      enum: ['user', 'provider'],
      required: true,
    },
    otp: {
      type: String,
      required: true,
      select: false, // Don't return by default
    },
    otpExpires: {
      type: Date,
      required: true,
    },
    resetToken: {
      type: String,
      select: false,
    },
    resetTokenExpires: {
      type: Date,
    },
    attempts: {
      type: Number,
      default: 0,
      max: 5, // Lock after 5 failed attempts
    },
    isLocked: {
      type: Boolean,
      default: false,
    },
    lockedUntil: {
      type: Date,
    },
    isUsed: {
      type: Boolean,
      default: false,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// TTL index to auto-delete expired OTP records after 24 hours
passwordResetOTPSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

// Hash OTP before saving
passwordResetOTPSchema.pre('save', async function (next) {
  if (!this.isModified('otp')) return next();

  // Hash OTP using SHA256
  this.otp = crypto.createHash('sha256').update(this.otp).digest('hex');
  next();
});

// Method to verify OTP
passwordResetOTPSchema.methods.verifyOTP = function (plainOTP) {
  const hashedOTP = crypto.createHash('sha256').update(plainOTP).digest('hex');
  return this.otp === hashedOTP;
};

// Method to generate reset token
passwordResetOTPSchema.methods.generateResetToken = function () {
  const resetToken = crypto.randomBytes(32).toString('hex');
  this.resetToken = crypto.createHash('sha256').update(resetToken).digest('hex');
  this.resetTokenExpires = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
  return resetToken; // Return unhashed token to send to client
};

// Method to check if account is locked
passwordResetOTPSchema.methods.isAccountLocked = function () {
  return this.isLocked && this.lockedUntil > new Date();
};

// Method to lock account
passwordResetOTPSchema.methods.lockAccount = function () {
  this.isLocked = true;
  this.lockedUntil = new Date(Date.now() + 30 * 60 * 1000); // Lock for 30 minutes
};

// Method to unlock account
passwordResetOTPSchema.methods.unlockAccount = function () {
  this.isLocked = false;
  this.lockedUntil = null;
  this.attempts = 0;
};

module.exports = mongoose.model('PasswordResetOTP', passwordResetOTPSchema);
