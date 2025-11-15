const nodemailer = require('nodemailer');

// Create transporter
const createTransporter = () => {
  if (process.env.NODE_ENV === 'production') {
    // Production transporter (use your email service)
    return nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: process.env.EMAIL_PORT,
      secure: false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  } else {
    // Development transporter (use Ethereal for testing)
    return nodemailer.createTransporter({
      host: 'smtp.ethereal.email',
      port: 587,
      auth: {
        user: 'ethereal.user@ethereal.email',
        pass: 'ethereal.pass',
      },
    });
  }
};

// Send email function
const sendEmail = async (options) => {
  const transporter = createTransporter();

  const mailOptions = {
    from: process.env.EMAIL_FROM || 'MetroMatrix <noreply@metromatrix.com>',
    to: options.email,
    subject: options.subject,
    text: options.message,
    html: options.html || options.message,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    
    if (process.env.NODE_ENV === 'development') {
      console.log('Message sent: %s', info.messageId);
      console.log('Preview URL: %s', nodemailer.getTestMessageUrl(info));
    }
    
    return info;
  } catch (error) {
    console.error('Email send error:', error);
    throw new Error('Failed to send email');
  }
};

// Email templates
const emailTemplates = {
  welcome: (user) => ({
    subject: 'Welcome to MetroMatrix!',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #6366f1;">Welcome to MetroMatrix, ${user.fullName}!</h1>
        <p>Thank you for joining our community service platform.</p>
        <p>Get started by completing your profile to unlock all features.</p>
        <a href="${process.env.CLIENT_URL}/complete-profile" 
           style="background-color: #6366f1; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
          Complete Your Profile
        </a>
        <p style="margin-top: 20px;">Best regards,<br>The MetroMatrix Team</p>
      </div>
    `,
  }),

  verifyEmail: (user, token) => ({
    subject: 'Verify Your Email - MetroMatrix',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #6366f1;">Verify Your Email</h1>
        <p>Hi ${user.fullName},</p>
        <p>Please click the button below to verify your email address:</p>
        <a href="${process.env.CLIENT_URL}/verify-email?token=${token}" 
           style="background-color: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
          Verify Email
        </a>
        <p>This link will expire in 24 hours.</p>
        <p style="margin-top: 20px;">If you didn't create an account, please ignore this email.</p>
        <p>Best regards,<br>The MetroMatrix Team</p>
      </div>
    `,
  }),

  resetPassword: (user, token) => ({
    subject: 'Password Reset Request - MetroMatrix',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #6366f1;">Password Reset</h1>
        <p>Hi ${user.fullName},</p>
        <p>You requested a password reset. Click the button below to reset your password:</p>
        <a href="${process.env.CLIENT_URL}/reset-password?token=${token}" 
           style="background-color: #ef4444; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
          Reset Password
        </a>
        <p>This link will expire in 10 minutes.</p>
        <p style="margin-top: 20px;">If you didn't request this, please ignore this email.</p>
        <p>Best regards,<br>The MetroMatrix Team</p>
      </div>
    `,
  }),

  providerApproved: (provider) => ({
    subject: 'Your Provider Account Has Been Approved!',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #10b981;">Congratulations, ${provider.fullName}!</h1>
        <p>Your provider account has been approved. You can now start offering your services on MetroMatrix.</p>
        <a href="${process.env.CLIENT_URL}/provider/dashboard" 
           style="background-color: #6366f1; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
          Go to Dashboard
        </a>
        <p style="margin-top: 20px;">Best regards,<br>The MetroMatrix Team</p>
      </div>
    `,
  }),

  providerRejected: (provider, reason) => ({
    subject: 'Provider Application Update - MetroMatrix',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #ef4444;">Application Update</h1>
        <p>Hi ${provider.fullName},</p>
        <p>Unfortunately, your provider application could not be approved at this time.</p>
        <p><strong>Reason:</strong> ${reason}</p>
        <p>Please address the issues mentioned and resubmit your application.</p>
        <a href="${process.env.CLIENT_URL}/provider/reapply" 
           style="background-color: #6366f1; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
          Reapply
        </a>
        <p style="margin-top: 20px;">Best regards,<br>The MetroMatrix Team</p>
      </div>
    `,
  }),
};

module.exports = {
  sendEmail,
  emailTemplates,
};