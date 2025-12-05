const crypto = require('crypto');
const User = require('../models/User');
const Provider = require('../models/Provider');
const { sendEmail } = require('./emailService');

class PasswordResetService {
  /**
   * Send password reset email
   * @param {String} email - User/Provider email
   * @param {String} userType - 'user' or 'provider'
   * @returns {Object} success response
   */
  static async sendPasswordResetEmail(email, userType = 'user') {
    const Model = userType === 'provider' ? Provider : User;
    const user = await Model.findOne({ email });

    if (!user) {
      throw new Error('No account found with this email address');
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpire = Date.now() + 10 * 60 * 1000; // 10 minutes
    await user.save();

    // Create reset URL
    const resetUrl = `${process.env.CLIENT_URL}/reset-password?token=${resetToken}&type=${userType}`;
    
    try {
      await sendEmail({
        email: user.email,
        subject: 'Password Reset Request - MetroMatrix',
        html: this.getPasswordResetTemplate(user.fullName, resetUrl),
      });

      return {
        success: true,
        message: 'Password reset email sent successfully',
        expiresIn: '10 minutes',
      };
    } catch (error) {
      // Rollback on email failure
      user.resetPasswordToken = undefined;
      user.resetPasswordExpire = undefined;
      await user.save();
      
      console.error('Password reset email error:', error);
      throw new Error('Failed to send password reset email. Please try again.');
    }
  }

  /**
   * Resend password reset email (same as sendPasswordResetEmail)
   * @param {String} email - User/Provider email
   * @param {String} userType - 'user' or 'provider'
   * @returns {Object} success response
   */
  static async resendPasswordResetEmail(email, userType = 'user') {
    return this.sendPasswordResetEmail(email, userType);
  }

  /**
   * Verify reset token validity
   * @param {String} token - Reset token
   * @param {String} userType - 'user' or 'provider'
   * @returns {Object} validation result
   */
  static async verifyResetToken(token, userType = 'user') {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    const Model = userType === 'provider' ? Provider : User;

    const user = await Model.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpire: { $gt: Date.now() },
    });

    if (!user) {
      throw new Error('Invalid or expired reset token');
    }

    return {
      success: true,
      valid: true,
      email: user.email,
      verificationToken: token, // Return the original token for frontend
    };
  }

  /**
   * Reset password with token
   * @param {String} token - Reset token
   * @param {String} newPassword - New password
   * @param {String} userType - 'user' or 'provider'
   * @returns {Object} success response
   */
  static async resetPassword(token, newPassword, userType = 'user') {
    if (!newPassword || newPassword.length < 6) {
      throw new Error('Password must be at least 6 characters long');
    }

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    const Model = userType === 'provider' ? Provider : User;

    const user = await Model.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpire: { $gt: Date.now() },
    });

    if (!user) {
      throw new Error('Invalid or expired reset token');
    }

    // Set new password (will be hashed by pre-save hook)
    user.password = newPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    
    // Clear refresh token to force re-login
    user.refreshToken = undefined;
    
    await user.save();

    // Send confirmation email
    try {
      await sendEmail({
        email: user.email,
        subject: 'Password Changed Successfully - MetroMatrix',
        html: this.getPasswordChangedTemplate(user.fullName),
      });
    } catch (error) {
      console.error('Password change confirmation email error:', error);
      // Don't throw error here, password was already changed
    }

    return {
      success: true,
      message: 'Password reset successfully',
    };
  }

  /**
   * Get password reset email template
   * @param {String} fullName - User's full name
   * @param {String} resetUrl - Password reset URL
   * @returns {String} HTML email template
   */
  static getPasswordResetTemplate(fullName, resetUrl) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Reset Your Password</title>
      </head>
      <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background-color: #ef4444; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0; font-size: 28px;">MetroMatrix</h1>
          </div>
          
          <div style="background-color: #ffffff; padding: 40px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px;">
            <h2 style="color: #1f2937; margin-top: 0;">Password Reset Request</h2>
            
            <p style="color: #4b5563; line-height: 1.6;">Hi ${fullName},</p>
            
            <p style="color: #4b5563; line-height: 1.6;">
              We received a request to reset your password for your MetroMatrix account. 
              Click the button below to choose a new password:
            </p>
            
            <div style="text-align: center; margin: 35px 0;">
              <a href="${resetUrl}" 
                 style="background-color: #ef4444; color: white; padding: 14px 40px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: 600; font-size: 16px;">
                Reset Password
              </a>
            </div>
            
            <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
              Or copy and paste this link into your browser:
            </p>
            <p style="color: #ef4444; word-break: break-all; font-size: 13px; background-color: #fef2f2; padding: 12px; border-radius: 6px;">
              ${resetUrl}
            </p>
            
            <div style="margin-top: 30px; padding: 20px; background-color: #fef2f2; border-radius: 8px; border-left: 4px solid #ef4444;">
              <p style="color: #991b1b; font-size: 14px; margin: 0; font-weight: 600;">
                ⚠️ Important Security Information
              </p>
              <ul style="color: #991b1b; font-size: 13px; margin: 10px 0 0 0; padding-left: 20px;">
                <li>This link will expire in 10 minutes</li>
                <li>If you didn't request this reset, please ignore this email</li>
                <li>Never share this link with anyone</li>
              </ul>
            </div>
            
            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
              <p style="color: #6b7280; font-size: 13px; margin: 0;">
                If you're having trouble with the button above, you can also click on the link or contact our support team.
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

  /**
   * Get password changed confirmation email template
   * @param {String} fullName - User's full name
   * @returns {String} HTML email template
   */
  static getPasswordChangedTemplate(fullName) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Password Changed Successfully</title>
      </head>
      <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background-color: #10b981; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0; font-size: 28px;">MetroMatrix</h1>
          </div>
          
          <div style="background-color: #ffffff; padding: 40px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px;">
            <div style="text-align: center; margin-bottom: 30px;">
              <div style="background-color: #d1fae5; width: 80px; height: 80px; border-radius: 50%; margin: 0 auto; display: flex; align-items: center; justify-content: center;">
                <span style="color: #10b981; font-size: 48px;">✓</span>
              </div>
            </div>
            
            <h2 style="color: #1f2937; margin-top: 0; text-align: center;">Password Changed Successfully</h2>
            
            <p style="color: #4b5563; line-height: 1.6;">Hi ${fullName},</p>
            
            <p style="color: #4b5563; line-height: 1.6;">
              Your MetroMatrix account password has been changed successfully. You can now sign in with your new password.
            </p>
            
            <div style="margin: 30px 0; padding: 20px; background-color: #fef3c7; border-radius: 8px; border-left: 4px solid #f59e0b;">
              <p style="color: #92400e; font-size: 14px; margin: 0;">
                <strong>Didn't make this change?</strong>
              </p>
              <p style="color: #92400e; font-size: 13px; margin: 10px 0 0 0;">
                If you didn't change your password, please contact our support team immediately at 
                <a href="mailto:waleedhassansfd@gmail.com" style="color: #f59e0b; text-decoration: none;">waleedhassansfd@gmail.com</a>
              </p>
            </div>
            
            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; text-align: center;">
              <p style="color: #6b7280; font-size: 13px; margin: 0;">
                For security reasons, you've been logged out of all devices. Please log in again with your new password.
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

module.exports = PasswordResetService;