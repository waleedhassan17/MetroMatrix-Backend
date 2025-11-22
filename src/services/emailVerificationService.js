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

    // Create verification URL
    const verificationUrl = `${process.env.CLIENT_URL}/verify-email?token=${token}&type=user`;
    
    try {
      await sendEmail({
        email: user.email,
        subject: 'Verify Your Email - MetroMatrix',
        html: this.getVerificationEmailTemplate(user.fullName, verificationUrl),
      });

      return {
        success: true,
        message: 'Verification email sent successfully',
        expiresIn: '24 hours',
      };
    } catch (error) {
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

    const verificationUrl = `${process.env.CLIENT_URL}/verify-email?token=${token}&type=provider`;
    
    try {
      await sendEmail({
        email: provider.email,
        subject: 'Verify Your Email - MetroMatrix Provider',
        html: this.getVerificationEmailTemplate(provider.fullName, verificationUrl),
      });

      return {
        success: true,
        message: 'Verification email sent successfully',
        expiresIn: '24 hours',
      };
    } catch (error) {
      provider.emailVerificationToken = undefined;
      provider.emailVerificationExpire = undefined;
      await provider.save();
      throw new Error('Failed to send verification email. Please try again.');
    }
  }

  /**
   * Verify email with token
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
   * @returns {String} HTML email template
   */
  static getVerificationEmailTemplate(fullName, verificationUrl) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Verify Your Email</title>
      </head>
      <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background-color: #6366f1; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0; font-size: 28px;">MetroMatrix</h1>
          </div>
          
          <div style="background-color: #ffffff; padding: 40px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px;">
            <h2 style="color: #1f2937; margin-top: 0;">Verify Your Email Address</h2>
            
            <p style="color: #4b5563; line-height: 1.6;">Hi ${fullName},</p>
            
            <p style="color: #4b5563; line-height: 1.6;">
              Thank you for registering with MetroMatrix! To complete your registration and access all features, 
              please verify your email address by clicking the button below:
            </p>
            
            <div style="text-align: center; margin: 35px 0;">
              <a href="${verificationUrl}" 
                 style="background-color: #6366f1; color: white; padding: 14px 40px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: 600; font-size: 16px;">
                Verify Email Address
              </a>
            </div>
            
            <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
              Or copy and paste this link into your browser:
            </p>
            <p style="color: #6366f1; word-break: break-all; font-size: 13px; background-color: #f3f4f6; padding: 12px; border-radius: 6px;">
              ${verificationUrl}
            </p>
            
            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
              <p style="color: #6b7280; font-size: 13px; margin: 0;">
                ⏰ This verification link will expire in 24 hours.
              </p>
              <p style="color: #6b7280; font-size: 13px; margin: 10px 0 0 0;">
                If you didn't create an account with MetroMatrix, please ignore this email.
              </p>
            </div>
          </div>
          
          <div style="text-align: center; margin-top: 20px; color: #9ca3af; font-size: 12px;">
            <p>© 2024 MetroMatrix. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }
}

module.exports = EmailVerificationService;