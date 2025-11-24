const crypto = require('crypto');
const User = require('../models/User');
const Provider = require('../models/Provider');
const { sendEmail } = require('./emailService');

class EmailVerificationService {
  /**
   * Generate a verification token
   * @returns {Object} token, hashedToken, and expireTime
   */
  static generateVerificationToken() {
    const token = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    const expireTime = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
    
    return { token, hashedToken, expireTime };
  }

  /**
   * Get the base URL for verification links
   * In production, this should be your Heroku backend URL
   * The backend will handle the verification and redirect to mobile app
   */
  static getVerificationBaseUrl() {
    // Use the API URL for verification (backend handles the web page)
    // This ensures the link is always accessible from email
    return process.env.API_URL || process.env.CLIENT_URL || 'http://localhost:5000';
  }

  /**
   * Send verification email for User
   * @param {String} email - User email
   * @returns {Object} success response
   */
  static async sendUserVerificationEmail(email) {
    const user = await User.findOne({ email });
    
    if (!user) {
      throw new Error('User not found with this email');
    }

    if (user.emailVerified) {
      throw new Error('Email is already verified');
    }

    // Check rate limiting (max 3 emails per hour)
    if (user.emailVerificationSentAt) {
      const hourAgo = Date.now() - 60 * 60 * 1000;
      if (user.emailVerificationSentAt > hourAgo && user.emailVerificationAttempts >= 3) {
        throw new Error('Too many verification emails sent. Please try again in an hour.');
      }
    }

    const { token, hashedToken, expireTime } = this.generateVerificationToken();

    // Update user
    user.emailVerificationToken = hashedToken;
    user.emailVerificationExpire = expireTime;
    user.emailVerificationSentAt = Date.now();
    user.emailVerificationAttempts = (user.emailVerificationAttempts || 0) + 1;
    await user.save();

    // Create verification URL - points to backend web page
    const baseUrl = this.getVerificationBaseUrl();
    const verificationUrl = `${baseUrl}/verify-email?token=${token}&type=user`;
    
    console.log('📧 Sending verification email to:', email);
    console.log('🔗 Verification URL:', verificationUrl);

    try {
      await sendEmail({
        email: user.email,
        subject: 'Verify Your Email - MetroMatrix',
        html: this.getVerificationEmailTemplate(user.fullName, verificationUrl, 'user'),
      });

      return {
        success: true,
        message: 'Verification email sent successfully',
        expiresIn: '24 hours',
      };
    } catch (error) {
      console.error('❌ Email send error:', error);
      // Rollback on email failure
      user.emailVerificationToken = undefined;
      user.emailVerificationExpire = undefined;
      await user.save();
      throw new Error('Failed to send verification email. Please try again.');
    }
  }

  /**
   * Send verification email for Provider
   * @param {String} email - Provider email
   * @returns {Object} success response
   */
  static async sendProviderVerificationEmail(email) {
    const provider = await Provider.findOne({ email });
    
    if (!provider) {
      throw new Error('Provider not found with this email');
    }

    if (provider.emailVerified) {
      throw new Error('Email is already verified');
    }

    // Check rate limiting
    if (provider.emailVerificationSentAt) {
      const hourAgo = Date.now() - 60 * 60 * 1000;
      if (provider.emailVerificationSentAt > hourAgo && provider.emailVerificationAttempts >= 3) {
        throw new Error('Too many verification emails sent. Please try again in an hour.');
      }
    }

    const { token, hashedToken, expireTime } = this.generateVerificationToken();

    provider.emailVerificationToken = hashedToken;
    provider.emailVerificationExpire = expireTime;
    provider.emailVerificationSentAt = Date.now();
    provider.emailVerificationAttempts = (provider.emailVerificationAttempts || 0) + 1;
    await provider.save();

    // Create verification URL - points to backend web page
    const baseUrl = this.getVerificationBaseUrl();
    const verificationUrl = `${baseUrl}/verify-email?token=${token}&type=provider`;

    console.log('📧 Sending provider verification email to:', email);
    console.log('🔗 Verification URL:', verificationUrl);

    try {
      await sendEmail({
        email: provider.email,
        subject: 'Verify Your Email - MetroMatrix Provider',
        html: this.getVerificationEmailTemplate(provider.fullName, verificationUrl, 'provider'),
      });

      return {
        success: true,
        message: 'Verification email sent successfully',
        expiresIn: '24 hours',
      };
    } catch (error) {
      console.error('❌ Email send error:', error);
      provider.emailVerificationToken = undefined;
      provider.emailVerificationExpire = undefined;
      await provider.save();
      throw new Error('Failed to send verification email. Please try again.');
    }
  }

  /**
   * Verify email with token (called from API, not web page)
   * @param {String} token - Verification token
   * @param {String} userType - 'user' or 'provider'
   * @returns {Object} success response
   */
  static async verifyEmail(token, userType = 'user') {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    
    const Model = userType === 'provider' ? Provider : User;
    
    const user = await Model.findOne({
      emailVerificationToken: hashedToken,
      emailVerificationExpire: { $gt: Date.now() },
    });

    if (!user) {
      throw new Error('Invalid or expired verification token');
    }

    // Mark email as verified
    user.emailVerified = true;
    user.isVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpire = undefined;
    user.emailVerificationAttempts = 0;
    
    if (userType === 'provider') {
      user.canLogin = true; // Provider can now login
    }
    
    await user.save();

    return {
      success: true,
      message: 'Email verified successfully',
      isVerified: true,
      canProceed: true,
    };
  }

  /**
   * Check verification status
   * @param {String} email - User/Provider email
   * @param {String} userType - 'user' or 'provider'
   * @returns {Object} verification status
   */
  static async checkVerificationStatus(email, userType = 'user') {
    const Model = userType === 'provider' ? Provider : User;
    const user = await Model.findOne({ email });

    if (!user) {
      throw new Error('Account not found');
    }

    return {
      success: true,
      emailVerified: user.emailVerified,
      isVerified: user.emailVerified,
      canLogin: userType === 'provider' ? user.canLogin : user.emailVerified,
      verificationPending: !user.emailVerified,
    };
  }

  /**
   * Get email template for verification
   * @param {String} fullName - User's full name
   * @param {String} verificationUrl - Verification URL
   * @param {String} userType - 'user' or 'provider'
   * @returns {String} HTML email template
   */
  static getVerificationEmailTemplate(fullName, verificationUrl, userType = 'user') {
    const isProvider = userType === 'provider';
    const accentColor = isProvider ? '#8b5cf6' : '#6366f1';
    const badgeText = isProvider ? 'Provider Account' : 'User Account';
    const badgeBg = isProvider ? '#f3e8ff' : '#e0e7ff';
    const badgeColor = isProvider ? '#7c3aed' : '#4f46e5';

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify Your Email - MetroMatrix</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    
    <!-- Header -->
    <div style="background: linear-gradient(135deg, ${accentColor} 0%, #a855f7 100%); padding: 40px 30px; text-align: center; border-radius: 16px 16px 0 0;">
      <h1 style="color: white; margin: 0; font-size: 32px; font-weight: 700; letter-spacing: -0.5px;">MetroMatrix</h1>
      <p style="color: rgba(255,255,255,0.9); margin: 8px 0 0 0; font-size: 14px;">Your Community Service Platform</p>
    </div>
    
    <!-- Content -->
    <div style="background-color: #ffffff; padding: 40px 30px; border-radius: 0 0 16px 16px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
      
      <!-- Badge -->
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="display: inline-block; background: ${badgeBg}; color: ${badgeColor}; padding: 6px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
          ${isProvider ? '🏥' : '👤'} ${badgeText}
        </span>
      </div>
      
      <h2 style="color: #1f2937; margin: 0 0 16px 0; font-size: 24px; font-weight: 700; text-align: center;">
        Verify Your Email Address
      </h2>
      
      <p style="color: #4b5563; line-height: 1.7; margin: 0 0 8px 0; font-size: 16px;">
        Hi <strong>${fullName}</strong>,
      </p>
      
      <p style="color: #4b5563; line-height: 1.7; margin: 0 0 32px 0; font-size: 16px;">
        Thank you for registering with MetroMatrix! To complete your registration and access all features, please verify your email address by clicking the button below:
      </p>
      
      <!-- CTA Button -->
      <div style="text-align: center; margin: 32px 0;">
        <a href="${verificationUrl}" 
           style="display: inline-block; background: linear-gradient(135deg, ${accentColor} 0%, #a855f7 100%); color: white; padding: 16px 48px; text-decoration: none; border-radius: 12px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 14px rgba(99, 102, 241, 0.4);">
          ✓ Verify Email Address
        </a>
      </div>
      
      <!-- Alternative Link -->
      <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 24px 0;">
        <p style="color: #6b7280; font-size: 13px; margin: 0 0 8px 0;">
          Or copy and paste this link into your browser:
        </p>
        <p style="color: ${accentColor}; word-break: break-all; font-size: 12px; margin: 0; font-family: monospace; background: #fff; padding: 10px; border-radius: 4px; border: 1px solid #e5e7eb;">
          ${verificationUrl}
        </p>
      </div>
      
      <!-- Info Box -->
      <div style="background: #fef3c7; border: 1px solid #fcd34d; border-radius: 8px; padding: 16px; margin: 24px 0;">
        <p style="color: #92400e; font-size: 14px; margin: 0;">
          ⏰ <strong>Important:</strong> This verification link will expire in 24 hours.
        </p>
      </div>
      
      <p style="color: #9ca3af; font-size: 14px; margin: 24px 0 0 0;">
        If you didn't create an account with MetroMatrix, please ignore this email or contact our support team.
      </p>
      
    </div>
    
    <!-- Footer -->
    <div style="text-align: center; margin-top: 32px; padding: 0 20px;">
      <p style="color: #9ca3af; font-size: 12px; margin: 0 0 8px 0;">
        © ${new Date().getFullYear()} MetroMatrix. All rights reserved.
      </p>
      <p style="color: #9ca3af; font-size: 12px; margin: 0;">
        This email was sent to verify your account registration.
      </p>
    </div>
    
  </div>
</body>
</html>
    `;
  }
}

module.exports = EmailVerificationService;