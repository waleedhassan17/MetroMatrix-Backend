const User = require('../models/User');
const Provider = require('../models/Provider');
const crypto = require('crypto');
const { generateTokens } = require('../utils/generateToken');
const { sendEmail, emailTemplates } = require('./emailService');

class AuthService {
  // Validate email format
  static isValidEmail(email) {
    const emailRegex = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/;
    return emailRegex.test(email);
  }

  // Validate phone number
  static isValidPhoneNumber(phoneNumber) {
    const phoneRegex = /^[0-9]{10,15}$/;
    return phoneRegex.test(phoneNumber.replace(/[\s-]/g, ''));
  }

  // Check if email already exists
  static async emailExists(email, excludeId = null) {
    const userExists = await User.findOne({ email, ...(excludeId && { _id: { $ne: excludeId } }) });
    if (userExists) return true;

    const providerExists = await Provider.findOne({ email, ...(excludeId && { _id: { $ne: excludeId } }) });
    return !!providerExists;
  }

  // Check if phone already exists
  static async phoneExists(phoneNumber, excludeId = null) {
    const userExists = await User.findOne({ phoneNumber, ...(excludeId && { _id: { $ne: excludeId } }) });
    if (userExists) return true;

    const providerExists = await Provider.findOne({ phoneNumber, ...(excludeId && { _id: { $ne: excludeId } }) });
    return !!providerExists;
  }

  // Register new user
  static async registerUser(userData) {
    const { fullName, phoneNumber, email, password } = userData;

    // Validate input
    if (!this.isValidEmail(email)) {
      throw new Error('Invalid email format');
    }

    if (!this.isValidPhoneNumber(phoneNumber)) {
      throw new Error('Invalid phone number');
    }

    if (password.length < 6) {
      throw new Error('Password must be at least 6 characters');
    }

    // Check if email exists
    if (await this.emailExists(email)) {
      throw new Error('Email already registered');
    }

    // Create user
    const user = await User.create({
      fullName,
      phoneNumber,
      email,
      password,
    });

    // Generate tokens
    const tokens = generateTokens(user._id);
    user.refreshToken = tokens.refreshToken;
    user.lastLoginDate = Date.now();

    // Generate verification token
    const verifyToken = user.getEmailVerificationToken();
    await user.save();

    // Send welcome email
    try {
      const emailContent = emailTemplates.welcome(user);
      await sendEmail({
        email: user.email,
        subject: emailContent.subject,
        html: emailContent.html,
      });
    } catch (error) {
      console.error('Error sending welcome email:', error);
    }

    return {
      user: user.toJSON(),
      ...tokens,
    };
  }

  // Register new provider
  static async registerProvider(providerData) {
    const { fullName, phoneNumber, email, password } = providerData;

    // Validate input
    if (!this.isValidEmail(email)) {
      throw new Error('Invalid email format');
    }

    if (!this.isValidPhoneNumber(phoneNumber)) {
      throw new Error('Invalid phone number');
    }

    if (password.length < 6) {
      throw new Error('Password must be at least 6 characters');
    }

    // Check if email exists
    if (await this.emailExists(email)) {
      throw new Error('Email already registered');
    }

    // Create provider
    const provider = await Provider.create({
      fullName,
      phoneNumber,
      email,
      password,
    });

    // Generate tokens
    const tokens = generateTokens(provider._id);
    provider.refreshToken = tokens.refreshToken;
    provider.lastLoginDate = Date.now();
    await provider.save();

    return {
      provider: provider.toJSON(),
      userType: 'provider',
      ...tokens,
    };
  }

  // Send password reset email
  static async sendPasswordResetEmail(email) {
    let user = await User.findOne({ email });
    let isProvider = false;

    if (!user) {
      user = await Provider.findOne({ email });
      isProvider = true;
    }

    if (!user) {
      throw new Error('No account found with this email');
    }

    // Generate reset token
    const resetToken = user.getResetPasswordToken();
    await user.save();

    // Send reset email
    const emailContent = emailTemplates.resetPassword(user, resetToken);
    await sendEmail({
      email: user.email,
      subject: emailContent.subject,
      html: emailContent.html,
    });

    return { success: true, userType: isProvider ? 'provider' : 'user' };
  }

  // Send email verification
  static async sendEmailVerification(userId) {
    const user = await User.findById(userId);

    if (!user) {
      throw new Error('User not found');
    }

    if (user.isVerified) {
      throw new Error('Email already verified');
    }

    const verifyToken = user.getEmailVerificationToken();
    await user.save();

    const emailContent = emailTemplates.verifyEmail(user, verifyToken);
    await sendEmail({
      email: user.email,
      subject: emailContent.subject,
      html: emailContent.html,
    });

    return { success: true };
  }

  // Send provider approval email
  static async sendProviderApprovalEmail(providerId, approved = true, reason = null) {
    const provider = await Provider.findById(providerId);

    if (!provider) {
      throw new Error('Provider not found');
    }

    let emailContent;
    if (approved) {
      emailContent = emailTemplates.providerApproved(provider);
    } else {
      emailContent = emailTemplates.providerRejected(provider, reason || 'Documents verification failed');
    }

    await sendEmail({
      email: provider.email,
      subject: emailContent.subject,
      html: emailContent.html,
    });

    return { success: true };
  }

  // Validate reset token
  static async validateResetToken(token) {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    let user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpire: { $gt: Date.now() },
    });

    if (!user) {
      user = await Provider.findOne({
        resetPasswordToken: hashedToken,
        resetPasswordExpire: { $gt: Date.now() },
      });
    }

    return user;
  }

  // Validate verification token
  static async validateVerificationToken(token) {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
      emailVerificationToken: hashedToken,
      emailVerificationExpire: { $gt: Date.now() },
    });

    return user;
  }
}

module.exports = AuthService;