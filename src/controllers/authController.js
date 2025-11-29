const asyncHandler = require('express-async-handler');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const Provider = require('../models/Provider');
const PendingSignup = require('../models/PendingSignup');
const PasswordResetOTP = require('../models/PasswordResetOTP');
const { generateTokens } = require('../utils/generateToken');
const { sendEmail, emailTemplates } = require('../services/emailService');
const EmailVerificationService = require('../services/emailVerificationService');

// @desc    Register user
// @route   POST /api/auth/register
// @access  Public
// ✅ UPDATED: Stores data in PendingSignup, creates User AFTER email verification
const registerUser = asyncHandler(async (req, res) => {
  const { fullName, phoneNumber, email, password } = req.body;
  
  // Check if user already exists
  const userExists = await User.findOne({ email });
  if (userExists) {
    res.status(400);
    throw new Error('User already exists with this email');
  }
  
  // Check if signup is already pending
  const pendingSignup = await PendingSignup.findOne({ email });
  if (pendingSignup) {
    res.status(400);
    throw new Error('Signup already pending for this email. Please verify your email or try again in 24 hours.');
  }
  
  // Validate input
  if (!fullName || !phoneNumber || !email || !password) {
    res.status(400);
    throw new Error('Please provide all required fields');
  }
  
  // Generate verification token
  const { token, hashedToken, expireTime } = EmailVerificationService.generateVerificationToken();
  
  try {
    // Store signup data temporarily in PendingSignup (auto-deletes after 24 hours)
    const pending = await PendingSignup.create({
      fullName,
      phoneNumber,
      email,
      password,
      verificationToken: hashedToken,
      verificationTokenExpire: expireTime,
      userType: 'user',
    });
    
    // Create verification URL
    const baseUrl = process.env.API_URL || process.env.CLIENT_URL || 'http://localhost:5000';
    const verificationUrl = `${baseUrl}/verify-email?token=${token}&type=user`;
    
    console.log('📧 Sending user signup verification email to:', email);
    console.log('🔗 Verification URL:', verificationUrl);
    
    // Send verification email
    await sendEmail({
      email: email,
      subject: 'Verify Your Email - MetroMatrix Registration',
      html: EmailVerificationService.getVerificationEmailTemplate(fullName, verificationUrl, 'user'),
    });
    
    res.status(201).json({
      success: true,
      message: 'Signup successful! Please verify your email to complete registration.',
      email: email,
      requiresEmailVerification: true,
      expiresIn: '24 hours',
      instructions: 'Check your email and click the verification link to complete your signup.',
    });
  } catch (error) {
    console.error('❌ Signup error:', error);
    res.status(500);
    throw new Error(error.message || 'Failed to complete signup. Please try again.');
  }
});

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
const loginUser = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  
  // Check for user email
  const user = await User.findOne({ email }).select('+password');
  
  if (user && (await user.matchPassword(password))) {
    const tokens = generateTokens(user._id);
    
    // Update user login info
    user.refreshToken = tokens.refreshToken;
    user.lastLoginDate = Date.now();
    await user.save();
    
    res.json({
      success: true,
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        phoneNumber: user.phoneNumber,
        profileComplete: user.profileComplete,
        isVerified: user.isVerified,
        profilePhoto: user.profilePhoto,
        dateOfBirth: user.dateOfBirth,
        gender: user.gender,
        address: user.address,
        preferences: user.preferences
      },
      ...tokens
    });
  } else {
    res.status(401);
    throw new Error('Invalid email or password');
  }
});

// @desc    Register provider
// @route   POST /api/auth/provider/register
// @access  Public
// ✅ UPDATED: Stores data in PendingSignup, creates Provider AFTER email verification
const registerProvider = asyncHandler(async (req, res) => {
  const { fullName, phoneNumber, email, password } = req.body;
  
  // Check if provider already exists
  const providerExists = await Provider.findOne({ email });
  if (providerExists) {
    res.status(400);
    throw new Error('Provider already exists with this email');
  }
  
  // Check if signup is already pending
  const pendingSignup = await PendingSignup.findOne({ email });
  if (pendingSignup) {
    res.status(400);
    throw new Error('Signup already pending for this email. Please verify your email or try again in 24 hours.');
  }
  
  // Validate input
  if (!fullName || !phoneNumber || !email || !password) {
    res.status(400);
    throw new Error('Please provide all required fields');
  }
  
  // Generate verification token
  const { token, hashedToken, expireTime } = EmailVerificationService.generateVerificationToken();
  
  try {
    // Store signup data temporarily in PendingSignup (auto-deletes after 24 hours)
    const pending = await PendingSignup.create({
      fullName,
      phoneNumber,
      email,
      password,
      verificationToken: hashedToken,
      verificationTokenExpire: expireTime,
      userType: 'provider',
    });
    
    // Create verification URL
    const baseUrl = process.env.API_URL || process.env.CLIENT_URL || 'http://localhost:5000';
    const verificationUrl = `${baseUrl}/verify-email?token=${token}&type=provider`;
    
    console.log('📧 Sending provider signup verification email to:', email);
    console.log('🔗 Verification URL:', verificationUrl);
    
    // Send verification email
    await sendEmail({
      email: email,
      subject: 'Verify Your Email - MetroMatrix Provider Registration',
      html: EmailVerificationService.getVerificationEmailTemplate(fullName, verificationUrl, 'provider'),
    });
    
    res.status(201).json({
      success: true,
      message: 'Provider signup successful! Please verify your email to complete registration.',
      email: email,
      requiresEmailVerification: true,
      expiresIn: '24 hours',
      instructions: 'Check your email and click the verification link to complete your provider signup.',
    });
  } catch (error) {
    console.error('❌ Signup error:', error);
    res.status(500);
    throw new Error(error.message || 'Failed to complete signup. Please try again.');
  }
});

// @desc    Login provider
// @route   POST /api/auth/provider/login
// @access  Public
const loginProvider = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  
  const provider = await Provider.findOne({ email }).select('+password');
  
  if (!provider) {
    res.status(401);
    throw new Error('Invalid email or password');
  }

  // Check email verification
  if (!provider.emailVerified || !provider.canLogin) {
    res.status(403);
    throw new Error('Please verify your email before logging in');
  }
  
  if (provider && (await provider.matchPassword(password))) {
    // Check admin approval
    if (provider.verificationStatus !== 'approved') {
      res.status(403);
      throw new Error('Your account is pending admin approval');
    }

    const tokens = generateTokens(provider._id);
    
    provider.refreshToken = tokens.refreshToken;
    provider.lastLoginDate = Date.now();
    await provider.save();
    
    res.json({
      success: true,
      provider: {
        id: provider._id,
        fullName: provider.fullName,
        email: provider.email,
        phoneNumber: provider.phoneNumber,
        providerType: provider.providerType,
        providerSubType: provider.providerSubType,
        profileComplete: provider.profileComplete,
        verificationStatus: provider.verificationStatus,
        isVerified: provider.isVerified,
        city: provider.city,
        ratings: provider.ratings
      },
      ...tokens
    });
  } else {
    res.status(401);
    throw new Error('Invalid email or password');
  }
});

// @desc    Google OAuth callback
// @route   GET /api/auth/google/callback
// @access  Public
const googleAuth = asyncHandler(async (req, res) => {
  const { user, info } = req;
  
  if (user) {
    const tokens = generateTokens(user._id);
    
    // Update refresh token
    user.refreshToken = tokens.refreshToken;
    user.lastLoginDate = Date.now();
    await user.save();
    
    // Redirect to mobile app with tokens
    const params = new URLSearchParams({
      token: tokens.accessToken,
      refresh: tokens.refreshToken,
      type: info.type,
      profileComplete: user.profileComplete,
    });
    
    res.redirect(`${process.env.CLIENT_URL}/auth/success?${params}`);
  } else {
    res.redirect(`${process.env.CLIENT_URL}/auth/error`);
  }
});

// @desc    Facebook OAuth callback
// @route   GET /api/auth/facebook/callback
// @access  Public
const facebookAuth = asyncHandler(async (req, res) => {
  const { user, info } = req;
  
  if (user) {
    const tokens = generateTokens(user._id);
    
    user.refreshToken = tokens.refreshToken;
    user.lastLoginDate = Date.now();
    await user.save();
    
    const params = new URLSearchParams({
      token: tokens.accessToken,
      refresh: tokens.refreshToken,
      type: info.type,
      profileComplete: user.profileComplete,
    });
    
    res.redirect(`${process.env.CLIENT_URL}/auth/success?${params}`);
  } else {
    res.redirect(`${process.env.CLIENT_URL}/auth/error`);
  }
});

// @desc    Refresh token
// @route   POST /api/auth/refresh
// @access  Public
const refreshToken = asyncHandler(async (req, res) => {
  const { refreshToken: token } = req.body;
  
  if (!token) {
    res.status(401);
    throw new Error('Refresh token not provided');
  }
  
  try {
    const decoded = jwt.verify(token, process.env.REFRESH_TOKEN_SECRET);
    
    // Find user or provider
    let user = await User.findById(decoded.id);
    let isProvider = false;
    
    if (!user) {
      user = await Provider.findById(decoded.id);
      isProvider = true;
    }
    
    if (!user || user.refreshToken !== token) {
      res.status(401);
      throw new Error('Invalid refresh token');
    }
    
    if (!user.isActive) {
      res.status(403);
      throw new Error('Account is deactivated');
    }
    
    const tokens = generateTokens(user._id);
    user.refreshToken = tokens.refreshToken;
    await user.save();
    
    res.json({
      success: true,
      ...tokens,
      userType: isProvider ? 'provider' : 'user',
    });
  } catch (error) {
    res.status(401);
    throw new Error('Invalid or expired refresh token');
  }
});

// @desc    Forgot password
// @route   POST /api/auth/forgot-password
// @access  Public
// ✅ UPDATED: Now sends OTP instead of direct reset link
const forgotPassword = asyncHandler(async (req, res) => {
  const { email, userType } = req.body;

  if (!email) {
    res.status(400);
    throw new Error('Email is required');
  }

  // Try to find user or provider
  let user = await User.findOne({ email });
  let type = 'user';

  if (!user) {
    user = await Provider.findOne({ email });
    type = 'provider';
  }

  if (!user) {
    res.status(404);
    throw new Error('No account found with this email');
  }

  // Check if account is already locked due to too many attempts
  const existingOTP = await PasswordResetOTP.findOne({ email }).select('+isLocked +lockedUntil');
  if (existingOTP && existingOTP.isAccountLocked()) {
    res.status(429);
    throw new Error(`Account temporarily locked. Please try again after 30 minutes.`);
  }

  // Generate 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    // Delete any existing OTP for this email
    await PasswordResetOTP.deleteMany({ email });

    // Create new OTP record
    const otpRecord = new PasswordResetOTP({
      email,
      userType: type,
      otp, // Will be hashed in pre-save hook
      otpExpires: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
      attempts: 0,
    });

    await otpRecord.save();

    // Send OTP to email
    await sendEmail({
      email: user.email,
      subject: 'Password Reset Code - MetroMatrix',
      html: `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9fafb; padding: 20px; border-radius: 8px;">
          <div style="background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #6366f1; font-size: 28px; margin: 0;">MetroMatrix</h1>
              <p style="color: #6b7280; margin: 8px 0 0 0; font-size: 14px;">Community Service Platform</p>
            </div>
            
            <h2 style="color: #1f2937; font-size: 24px; margin-bottom: 8px;">Password Reset Code</h2>
            <p style="color: #6b7280; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0;">
              Hi ${user.fullName},
            </p>
            
            <p style="color: #6b7280; font-size: 15px; line-height: 1.6; margin: 0 0 28px 0;">
              Your password reset code is:
            </p>
            
            <div style="text-align: center; margin: 32px 0; background: #f0f0f0; padding: 20px; border-radius: 8px;">
              <div style="font-size: 42px; font-weight: 700; color: #6366f1; letter-spacing: 4px; font-family: 'Courier New', monospace;">
                ${otp}
              </div>
              <p style="color: #9ca3af; font-size: 13px; margin: 12px 0 0 0;">
                This code will expire in 10 minutes
              </p>
            </div>
            
            <div style="background: #fef3c7; border: 1px solid #fcd34d; border-radius: 6px; padding: 16px; margin: 20px 0; color: #92400e; font-size: 13px;">
              <strong>⚠️ Security:</strong> Never share this code with anyone. MetroMatrix support will never ask for your code.
            </div>
            
            <p style="color: #6b7280; font-size: 14px; margin: 20px 0 0 0;">
              If you didn't request this password reset, please ignore this email or <a href="mailto:sp23-bcs-104@cuilahore.edu.pk" style="color: #6366f1; text-decoration: none;">contact support</a> immediately.
            </p>
            
            <p style="color: #6b7280; font-size: 13px; margin: 30px 0 0 0; padding-top: 20px; border-top: 1px solid #e5e7eb;">
              Best regards,<br/>
              <strong>The MetroMatrix Team</strong>
            </p>
            
            <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 12px;">
              <p style="margin: 0;">© 2024 MetroMatrix. All rights reserved.</p>
              <p style="margin: 8px 0 0 0;">
                <a href="https://metromatrix-api-2e35f5f074df.herokuapp.com/privacy-policy" style="color: #6b7280; text-decoration: none;">Privacy Policy</a> | 
                <a href="https://metromatrix-api-2e35f5f074df.herokuapp.com/terms-of-service" style="color: #6b7280; text-decoration: none;">Terms of Service</a>
              </p>
            </div>
          </div>
        </div>
      `,
    });

    res.json({
      success: true,
      message: 'Password reset code sent to your email',
      email: user.email,
      expiresIn: 600, // 10 minutes in seconds
    });
  } catch (error) {
    console.error('Error sending OTP:', error);
    res.status(500);
    throw new Error('Failed to send password reset code. Please try again.');
  }
});

// @desc    Verify OTP and get reset token
// @route   POST /api/auth/verify-reset-otp
// @access  Public
// ✅ NEW: Verify OTP and return reset token
const verifyResetOTP = asyncHandler(async (req, res) => {
  const { email, otp, userType } = req.body;

  if (!email || !otp) {
    res.status(400);
    throw new Error('Email and OTP are required');
  }

  // Find OTP record
  const otpRecord = await PasswordResetOTP.findOne({ email }).select('+otp +isLocked +lockedUntil');

  if (!otpRecord) {
    res.status(400);
    throw new Error('Invalid or expired OTP. Request a new code.');
  }

  // Check if account is locked
  if (otpRecord.isAccountLocked()) {
    res.status(429);
    throw new Error('Too many failed attempts. Please try again after 30 minutes.');
  }

  // Check if OTP is expired
  if (otpRecord.otpExpires < new Date()) {
    res.status(400);
    throw new Error('OTP has expired. Please request a new code.');
  }

  // Check if OTP is already used
  if (otpRecord.isUsed) {
    res.status(400);
    throw new Error('This OTP has already been used. Please request a new code.');
  }

  // Verify OTP
  if (!otpRecord.verifyOTP(otp)) {
    otpRecord.attempts += 1;
    
    // Lock account after 5 failed attempts
    if (otpRecord.attempts >= 5) {
      otpRecord.lockAccount();
      await otpRecord.save();
      res.status(429);
      throw new Error('Too many failed attempts. Account locked for 30 minutes.');
    }

    await otpRecord.save();
    res.status(400);
    throw new Error(`Invalid OTP. You have ${5 - otpRecord.attempts} attempts remaining.`);
  }

  // OTP is valid - generate reset token
  const resetToken = otpRecord.generateResetToken();
  otpRecord.isUsed = true;
  otpRecord.attempts = 0;
  await otpRecord.save();

  res.json({
    success: true,
    message: 'OTP verified successfully',
    resetToken,
    email: otpRecord.email,
    expiresIn: 300, // 5 minutes in seconds
  });
});

// @desc    Resend OTP
// @route   POST /api/auth/resend-reset-otp
// @access  Public
// ✅ NEW: Resend OTP with rate limiting
const resendResetOTP = asyncHandler(async (req, res) => {
  const { email, userType } = req.body;

  if (!email) {
    res.status(400);
    throw new Error('Email is required');
  }

  // Find existing OTP record
  const otpRecord = await PasswordResetOTP.findOne({ email }).select('+createdAt');

  if (otpRecord) {
    // Check if account is locked
    if (otpRecord.isAccountLocked()) {
      res.status(429);
      throw new Error('Account temporarily locked due to too many attempts. Please try again after 30 minutes.');
    }

    // Rate limiting: Max 3 resends per 10 minutes
    const timeSinceCreation = (Date.now() - otpRecord.createdAt.getTime()) / 1000; // seconds
    if (timeSinceCreation < 600) { // Within 10 minutes
      const timeToWait = Math.ceil(120 - (timeSinceCreation % 120)); // 2 minutes between resends
      if (timeToWait > 0) {
        res.status(429);
        throw new Error(`Please wait ${timeToWait} seconds before requesting a new code`);
      }
    }

    // Delete old OTP
    await PasswordResetOTP.deleteOne({ _id: otpRecord._id });
  }

  // Try to find user or provider
  let user = await User.findOne({ email });
  let type = 'user';

  if (!user) {
    user = await Provider.findOne({ email });
    type = 'provider';
  }

  if (!user) {
    res.status(404);
    throw new Error('No account found with this email');
  }

  // Generate new OTP
  const newOtp = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    // Create new OTP record
    const newOtpRecord = new PasswordResetOTP({
      email,
      userType: type,
      otp: newOtp,
      otpExpires: new Date(Date.now() + 10 * 60 * 1000),
      attempts: 0,
    });

    await newOtpRecord.save();

    // Send OTP to email
    await sendEmail({
      email: user.email,
      subject: 'New Password Reset Code - MetroMatrix',
      html: `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9fafb; padding: 20px; border-radius: 8px;">
          <div style="background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #6366f1; font-size: 28px; margin: 0;">MetroMatrix</h1>
            </div>
            
            <h2 style="color: #1f2937; font-size: 24px; margin-bottom: 8px;">New Password Reset Code</h2>
            <p style="color: #6b7280; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0;">
              Hi ${user.fullName},
            </p>
            
            <p style="color: #6b7280; font-size: 15px; line-height: 1.6; margin: 0 0 28px 0;">
              Here's your new password reset code:
            </p>
            
            <div style="text-align: center; margin: 32px 0; background: #f0f0f0; padding: 20px; border-radius: 8px;">
              <div style="font-size: 42px; font-weight: 700; color: #6366f1; letter-spacing: 4px; font-family: 'Courier New', monospace;">
                ${newOtp}
              </div>
              <p style="color: #9ca3af; font-size: 13px; margin: 12px 0 0 0;">
                This code will expire in 10 minutes
              </p>
            </div>
            
            <p style="color: #6b7280; font-size: 13px; margin: 20px 0 0 0; padding-top: 20px; border-top: 1px solid #e5e7eb;">
              Best regards,<br/>
              <strong>The MetroMatrix Team</strong>
            </p>
          </div>
        </div>
      `,
    });

    res.json({
      success: true,
      message: 'New password reset code sent to your email',
      email: user.email,
      expiresIn: 600,
    });
  } catch (error) {
    console.error('Error sending new OTP:', error);
    res.status(500);
    throw new Error('Failed to send new password reset code. Please try again.');
  }
});

// @desc    Reset password with reset token
// @route   POST /api/auth/reset-password
// @access  Public
// ✅ UPDATED: Now uses reset token from OTP verification
const resetPassword = asyncHandler(async (req, res) => {
  const { resetToken, password } = req.body;

  if (!resetToken || !password) {
    res.status(400);
    throw new Error('Reset token and password are required');
  }

  // Validate password
  if (password.length < 6) {
    res.status(400);
    throw new Error('Password must be at least 6 characters long');
  }

  // Find OTP record with matching reset token
  const hashedResetToken = crypto.createHash('sha256').update(resetToken).digest('hex');
  
  const otpRecord = await PasswordResetOTP.findOne({
    resetToken: hashedResetToken,
    resetTokenExpires: { $gt: Date.now() },
  }).select('+resetTokenExpires');

  if (!otpRecord) {
    res.status(400);
    throw new Error('Invalid or expired reset token');
  }

  // Find user or provider
  const Model = otpRecord.userType === 'provider' ? Provider : User;
  const user = await Model.findOne({ email: otpRecord.email });

  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  // Update password
  user.password = password;
  
  // Clear any existing reset tokens if using old model fields
  if (user.resetPasswordToken) {
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
  }

  await user.save();

  // Delete OTP record
  await PasswordResetOTP.deleteOne({ _id: otpRecord._id });

  console.log(`✅ Password reset successful for ${otpRecord.userType}: ${user.email}`);

  res.json({
    success: true,
    message: 'Password reset successfully. You can now login with your new password.',
    userType: otpRecord.userType,
    email: user.email,
    user: {
      id: user._id,
      email: user.email,
      fullName: user.fullName,
    },
  });
});

// @desc    Verify email
// @route   POST /api/auth/verify-email
// @access  Public
const verifyEmail = asyncHandler(async (req, res) => {
  const { token, userType = 'user' } = req.body;
  
  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
  const Model = userType === 'provider' ? Provider : User;
  
  const user = await Model.findOne({
    emailVerificationToken: hashedToken,
    emailVerificationExpire: { $gt: Date.now() },
  });
  
  if (!user) {
    res.status(400);
    throw new Error('Invalid or expired verification token');
  }
  
  // Set both emailVerified and isVerified
  user.emailVerified = true;
  user.isVerified = true;
  user.emailVerificationToken = undefined;
  user.emailVerificationExpire = undefined;
  user.emailVerificationAttempts = 0;
  
  // For providers, also enable login
  if (userType === 'provider') {
    user.canLogin = true;
  }
  
  await user.save();
  
  res.json({
    success: true,
    message: 'Email verified successfully',
    emailVerified: true,
    isVerified: true,
  });
});

// @desc    Send verification email
// @route   POST /api/auth/send-verification-email
// @access  Public
const sendVerificationEmail = asyncHandler(async (req, res) => {
  const { email, userType = 'user' } = req.body;

  if (!email) {
    res.status(400);
    throw new Error('Email is required');
  }

  try {
    let result;
    if (userType === 'provider') {
      result = await EmailVerificationService.sendProviderVerificationEmail(email);
    } else {
      result = await EmailVerificationService.sendUserVerificationEmail(email);
    }

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    res.status(400);
    throw new Error(error.message);
  }
});

// ✅ UPDATED: Verify email with token AND create user/provider AND return auth tokens for auto-login
// @desc    Verify email with token and return authenticated session
// @route   POST /api/auth/verify-email-token
// @access  Public
const verifyEmailToken = asyncHandler(async (req, res) => {
  const { token, userType = 'user' } = req.body;

  if (!token) {
    res.status(400);
    throw new Error('Verification token is required');
  }

  try {
    // Hash the token
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    
    // Find pending signup with valid token
    const pending = await PendingSignup.findOne({
      verificationToken: hashedToken,
      verificationTokenExpire: { $gt: Date.now() },
      userType: userType,
    }).select('+password');

    if (!pending) {
      res.status(400);
      throw new Error('Invalid or expired verification token');
    }

    // Now create the actual user/provider from pending signup data
    let user;
    if (userType === 'provider') {
      // Create Provider
      user = await Provider.create({
        fullName: pending.fullName,
        phoneNumber: pending.phoneNumber,
        email: pending.email,
        password: pending.password,
        emailVerified: true,
        isVerified: true,
        canLogin: true,
      });
    } else {
      // Create User
      user = await User.create({
        fullName: pending.fullName,
        phoneNumber: pending.phoneNumber,
        email: pending.email,
        password: pending.password,
        emailVerified: true,
        isVerified: true,
      });
    }

    // Generate auth tokens
    const tokens = generateTokens(user._id);
    user.refreshToken = tokens.refreshToken;
    user.lastLoginDate = Date.now();
    await user.save();

    // Delete pending signup record
    await PendingSignup.deleteOne({ _id: pending._id });

    // Return user/provider data with tokens
    const userData = userType === 'provider' ? {
      id: user._id,
      fullName: user.fullName,
      email: user.email,
      phoneNumber: user.phoneNumber,
      providerType: user.providerType,
      profileComplete: user.profileComplete,
      verificationStatus: user.verificationStatus,
      emailVerified: user.emailVerified,
      canLogin: user.canLogin,
    } : {
      id: user._id,
      fullName: user.fullName,
      email: user.email,
      phoneNumber: user.phoneNumber,
      profileComplete: user.profileComplete,
      emailVerified: user.emailVerified,
    };

    res.json({
      success: true,
      message: 'Email verified successfully! Your account has been created. You are now logged in.',
      isVerified: true,
      emailVerified: true,
      [userType === 'provider' ? 'provider' : 'user']: userData,
      ...tokens, // Return accessToken and refreshToken
    });
  } catch (error) {
    console.error('❌ Verification error:', error);
    res.status(400);
    throw new Error(error.message || 'Verification failed. Please try again.');
  }
});

// ===== DEDICATED USER VERIFICATION =====
// @desc    Verify user email with token - USER ONLY
// @route   POST /api/auth/user/verify-email
// @access  Public
const verifyUserEmail = asyncHandler(async (req, res) => {
  const { token } = req.body;

  if (!token) {
    res.status(400);
    throw new Error('Verification token is required');
  }

  try {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    
    // Find pending USER signup with valid token
    const pending = await PendingSignup.findOne({
      verificationToken: hashedToken,
      verificationTokenExpire: { $gt: Date.now() },
      userType: 'user',
    }).select('+password');

    if (!pending) {
      res.status(400);
      throw new Error('Invalid or expired verification token. This link may have expired.');
    }

    // Create User account
    const user = await User.create({
      fullName: pending.fullName,
      phoneNumber: pending.phoneNumber,
      email: pending.email,
      password: pending.password,
      emailVerified: true,
      isVerified: true,
    });

    // Generate auth tokens for auto-login
    const tokens = generateTokens(user._id);
    user.refreshToken = tokens.refreshToken;
    user.lastLoginDate = Date.now();
    await user.save();

    // Delete pending signup record
    await PendingSignup.deleteOne({ _id: pending._id });

    console.log(`✅ User verified and created: ${user.email}`);

    res.json({
      success: true,
      message: 'Email verified successfully! Welcome to MetroMatrix.',
      isVerified: true,
      emailVerified: true,
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        phoneNumber: user.phoneNumber,
        profileComplete: user.profileComplete,
        emailVerified: user.emailVerified,
      },
      ...tokens,
    });
  } catch (error) {
    console.error('❌ User verification error:', error);
    res.status(400);
    throw new Error(error.message || 'User verification failed. Please try again.');
  }
});

// ===== DEDICATED PROVIDER VERIFICATION =====
// @desc    Verify provider email with token - PROVIDER ONLY
// @route   POST /api/auth/provider/verify-email
// @access  Public
const verifyProviderEmail = asyncHandler(async (req, res) => {
  const { token } = req.body;

  if (!token) {
    res.status(400);
    throw new Error('Verification token is required');
  }

  try {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    
    // Find pending PROVIDER signup with valid token
    const pending = await PendingSignup.findOne({
      verificationToken: hashedToken,
      verificationTokenExpire: { $gt: Date.now() },
      userType: 'provider',
    }).select('+password');

    if (!pending) {
      res.status(400);
      throw new Error('Invalid or expired verification token. This link may have expired.');
    }

    // Create Provider account with login enabled
    const provider = await Provider.create({
      fullName: pending.fullName,
      phoneNumber: pending.phoneNumber,
      email: pending.email,
      password: pending.password,
      emailVerified: true,
      isVerified: true,
      canLogin: true, // ✅ Provider CAN login after email verification
      verificationStatus: 'pending', // Still pending admin approval for full access
    });

    // ✅ Generate auth tokens for provider (can login, but limited until approved)
    const tokens = generateTokens(provider._id);
    provider.refreshToken = tokens.refreshToken;
    provider.lastLoginDate = Date.now();
    await provider.save();

    // Delete pending signup record
    await PendingSignup.deleteOne({ _id: pending._id });

    console.log(`✅ Provider verified and created (email verified, pending admin approval): ${provider.email}`);

    res.json({
      success: true,
      message: 'Email verified successfully! You can now login. Your account is pending admin approval for full provider features.',
      isVerified: true,
      emailVerified: true,
      canLogin: true,
      verificationStatus: 'pending',
      provider: {
        id: provider._id,
        fullName: provider.fullName,
        email: provider.email,
        phoneNumber: provider.phoneNumber,
        emailVerified: provider.emailVerified,
        canLogin: provider.canLogin,
        verificationStatus: provider.verificationStatus,
      },
      // ✅ Return auth tokens - provider can login with limited access
      ...tokens,
    });
  } catch (error) {
    console.error('❌ Provider verification error:', error);
    res.status(400);
    throw new Error(error.message || 'Provider verification failed. Please try again.');
  }
});

// @desc    Check email verification status
// @route   POST /api/auth/check-verification-status
// @access  Public
const checkEmailVerificationStatus = asyncHandler(async (req, res) => {
  const { email, userType = 'user' } = req.body;

  if (!email) {
    res.status(400);
    throw new Error('Email is required');
  }

  try {
    const result = await EmailVerificationService.checkVerificationStatus(email, userType);
    
    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    res.status(400);
    throw new Error(error.message);
  }
});

// ============================================
// 🔧 DEBUGGING HELPERS
// ============================================

// @desc    Reset email verification rate limit
// @route   POST /api/auth/reset-verification-limit
// @access  Public (should be protected in production)
const resetVerificationLimit = asyncHandler(async (req, res) => {
  const { email, userType = 'user' } = req.body;

  if (!email) {
    res.status(400);
    throw new Error('Email is required');
  }

  const Model = userType === 'provider' ? Provider : User;
  const user = await Model.findOne({ email });

  if (!user) {
    res.status(404);
    throw new Error(`${userType === 'provider' ? 'Provider' : 'User'} not found`);
  }

  // Reset rate limiting fields
  user.emailVerificationAttempts = 0;
  user.emailVerificationSentAt = undefined;
  await user.save();

  res.json({
    success: true,
    message: 'Verification rate limit reset successfully',
    email: user.email,
  });
});

// @desc    Manual email verification (bypass email)
// @route   POST /api/auth/manual-verify
// @access  Public (should be protected in production)
const manualVerifyEmail = asyncHandler(async (req, res) => {
  const { email, userType = 'user' } = req.body;

  if (!email) {
    res.status(400);
    throw new Error('Email is required');
  }

  const Model = userType === 'provider' ? Provider : User;
  const user = await Model.findOne({ email });

  if (!user) {
    res.status(404);
    throw new Error(`${userType === 'provider' ? 'Provider' : 'User'} not found`);
  }

  // Manually verify the email
  user.emailVerified = true;
  user.isVerified = true;
  user.emailVerificationToken = undefined;
  user.emailVerificationExpire = undefined;
  user.emailVerificationAttempts = 0;

  if (userType === 'provider') {
    user.canLogin = true;
  }

  await user.save();

  res.json({
    success: true,
    message: 'Email verified manually',
    data: {
      email: user.email,
      emailVerified: user.emailVerified,
      canLogin: userType === 'provider' ? user.canLogin : true,
    },
  });
});

// @desc    Get verification status by email (GET route)
// @route   GET /api/auth/verification-status/:email
// @access  Public
const getVerificationStatus = asyncHandler(async (req, res) => {
  const { email } = req.params;
  const { userType = 'user' } = req.query;

  if (!email) {
    res.status(400);
    throw new Error('Email is required');
  }

  try {
    const result = await EmailVerificationService.checkVerificationStatus(email, userType);
    
    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    res.status(400);
    throw new Error(error.message);
  }
});

// @desc    Logout
// @route   POST /api/auth/logout
// @access  Private
const logout = asyncHandler(async (req, res) => {
  const user = req.user;
  
  user.refreshToken = undefined;
  await user.save();
  
  res.json({
    success: true,
    message: 'Logged out successfully',
  });
});

module.exports = {
  registerUser,
  loginUser,
  registerProvider,
  loginProvider,
  googleAuth,
  facebookAuth,
  refreshToken,
  forgotPassword,
  resetPassword,
  verifyResetOTP,             // ✅ NEW - Verify OTP for password reset
  resendResetOTP,             // ✅ NEW - Resend OTP
  verifyEmail,
  verifyEmailToken,           // Generic verification (uses userType param)
  verifyUserEmail,            // ✅ NEW - User-specific verification
  verifyProviderEmail,        // ✅ NEW - Provider-specific verification
  sendVerificationEmail,
  checkEmailVerificationStatus,
  resetVerificationLimit,
  manualVerifyEmail,
  getVerificationStatus,
  logout,
};