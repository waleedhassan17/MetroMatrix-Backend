const nodemailer = require('nodemailer');

/**
 * True when this deployment has real SMTP credentials configured.
 *
 * The transporter used to be chosen by NODE_ENV alone, so anything that
 * wasn't `production` silently got a dummy Ethereal account and no mail ever
 * reached a real inbox (task.md Issue 4, root cause A). Configuration — not
 * the environment name — decides now: if you gave us a host/user, we send
 * for real, whether that's local dev, staging or Vercel.
 */
const isSmtpConfigured = () =>
  Boolean(process.env.EMAIL_HOST || process.env.EMAIL_USER);

// Create transporter
const createTransporter = () => {
  if (isSmtpConfigured()) {
    const port = Number(process.env.EMAIL_PORT) || 587;

    return nodemailer.createTransport({
      host: process.env.EMAIL_HOST || 'smtp.gmail.com',
      port,
      // 465 is implicit TLS; 587 is STARTTLS, which is what Gmail wants and
      // which nodemailer upgrades to automatically when secure is false.
      secure: port === 465,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  }

  // Nothing configured — fall back to Ethereal so dev doesn't crash. These
  // credentials are not real, so sending will fail loudly rather than
  // pretending to have delivered.
  console.warn(
    '⚠️  No SMTP configured (EMAIL_HOST/EMAIL_USER unset) — falling back to Ethereal. ' +
    'No mail will reach real inboxes.'
  );
  return nodemailer.createTransport({
    host: 'smtp.ethereal.email',
    port: 587,
    secure: false,
    auth: {
      user: 'ethereal.user@ethereal.email',
      pass: 'ethereal.pass',
    },
  });
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

    // Worth a line in every environment: "did the mail actually go out" is
    // the single most common question when debugging the signup flow.
    console.log(`📨 Mail accepted for ${options.email} (messageId: ${info.messageId})`);

    if (!isSmtpConfigured()) {
      console.log('Preview URL: %s', nodemailer.getTestMessageUrl(info));
    }

    return info;
  } catch (error) {
    // Keep the real reason — "Invalid login", "self signed certificate",
    // ECONNREFUSED — instead of flattening every failure to one string.
    console.error('Email send error:', error);
    throw new Error(`Failed to send email: ${error.message}`);
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

  verifyEmail: (user, verificationUrl) => ({
    subject: 'Verify Your Email - MetroMatrix',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #6366f1;">Verify Your Email</h1>
        <p>Hi ${user.fullName},</p>
        <p>Thank you for registering with MetroMatrix! Please verify your email address to complete your registration.</p>
        <p style="margin: 30px 0;">
          <a href="${verificationUrl}" 
             style="background-color: #6366f1; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
            Verify Email Address
          </a>
        </p>
        <p>Or copy and paste this link into your browser:</p>
        <p style="color: #666; word-break: break-all;">${verificationUrl}</p>
        <p style="margin-top: 30px; color: #666;">This link will expire in 24 hours.</p>
        <p>If you didn't create an account, please ignore this email.</p>
        <p style="margin-top: 30px;">Best regards,<br>The MetroMatrix Team</p>
      </div>
    `,
  }),

  resetPassword: (user, resetUrl) => ({
    subject: 'Password Reset Request - MetroMatrix',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #6366f1;">Password Reset</h1>
        <p>Hi ${user.fullName},</p>
        <p>You requested a password reset. Click the button below to reset your password:</p>
        <p style="margin: 30px 0;">
          <a href="${resetUrl}" 
             style="background-color: #ef4444; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
            Reset Password
          </a>
        </p>
        <p>Or copy and paste this link into your browser:</p>
        <p style="color: #666; word-break: break-all;">${resetUrl}</p>
        <p style="margin-top: 30px; color: #666;">This link will expire in 10 minutes.</p>
        <p>If you didn't request this, please ignore this email and your password will remain unchanged.</p>
        <p style="margin-top: 30px;">Best regards,<br>The MetroMatrix Team</p>
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
  createTransporter,
  isSmtpConfigured,
};