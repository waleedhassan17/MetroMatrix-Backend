const asyncHandler = require('express-async-handler');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const Provider = require('../models/Provider');
const PendingSignup = require('../models/PendingSignup');
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
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  
  // Try to find user or provider
  let user = await User.findOne({ email });
  let isProvider = false;
  
  if (!user) {
    user = await Provider.findOne({ email });
    isProvider = true;
  }
  
  if (!user) {
    res.status(404);
    throw new Error('No account found with this email');
  }
  
  // Get reset token
  const resetToken = user.getResetPasswordToken();
  await user.save();
  
  // Create reset URL (using web page instead of client URL)
  const resetUrl = `https://metromatrix-api-2e35f5f074df.herokuapp.com/reset-password?token=${resetToken}&type=${
    isProvider ? 'provider' : 'user'
  }`;
  
  try {
    // Send email with proper template
    await sendEmail({
      email: user.email,
      subject: 'Password Reset Request - MetroMatrix',
      html: `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9fafb; padding: 20px; border-radius: 8px;">
          <div style="background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #6366f1; font-size: 28px; margin: 0;">MetroMatrix</h1>
              <p style="color: #6b7280; margin: 8px 0 0 0; font-size: 14px;">Community Service Platform</p>
            </div>
            
            <h2 style="color: #1f2937; font-size: 24px; margin-bottom: 8px;">Reset Your Password</h2>
            <p style="color: #6b7280; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0;">
              Hi ${user.fullName},
            </p>
            
            <p style="color: #6b7280; font-size: 15px; line-height: 1.6; margin: 0 0 28px 0;">
              We received a request to reset your password. Click the button below to securely reset your password. This link will expire in <strong>10 minutes</strong>.
            </p>
            
            <div style="text-align: center; margin: 32px 0;">
              <a href="${resetUrl}" 
                 style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); color: white; padding: 14px 40px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: 600; font-size: 16px; transition: transform 0.3s;">
                Reset Password
              </a>
            </div>
            
            <p style="color: #6b7280; font-size: 13px; margin: 28px 0 0 0; padding-top: 20px; border-top: 1px solid #e5e7eb;">
              Or copy and paste this link in your browser:
            </p>
            <p style="color: #6366f1; font-size: 12px; word-break: break-all; margin: 8px 0; background: #f0f0f0; padding: 12px; border-radius: 4px;">
              ${resetUrl}
            </p>
            
            <div style="background: #fef3c7; border: 1px solid #fcd34d; border-radius: 6px; padding: 16px; margin: 20px 0; color: #92400e; font-size: 13px;">
              <strong>⚠️ Security Notice:</strong> Never share this link with anyone. MetroMatrix team will never ask for your password via email.
            </div>
            
            <p style="color: #6b7280; font-size: 14px; margin: 20px 0 0 0;">
              If you didn't request this password reset, please ignore this email or <a href="mailto:sp23-bcs-104@cuilahore.edu.pk" style="color: #6366f1; text-decoration: none;">contact support</a> if you have concerns.
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
      message: 'Password reset email sent successfully',
      email: user.email,
    });
  } catch (error) {
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    await user.save();
    
    res.status(500);
    throw new Error('Email could not be sent');
  }
});

// @desc    Reset password
// @route   POST /api/auth/reset-password
// @access  Public
const resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  
  // Get hashed token
  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
  
  // Find user or provider with token
  let user = await User.findOne({
    resetPasswordToken: hashedToken,
    resetPasswordExpire: { $gt: Date.now() },
  });
  let isProvider = false;
  
  if (!user) {
    user = await Provider.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpire: { $gt: Date.now() },
    });
    isProvider = true;
  }
  
  if (!user) {
    res.status(400);
    throw new Error('Invalid or expired reset token');
  }
  
  // Set new password
  user.password = password;
  user.resetPasswordToken = undefined;
  user.resetPasswordExpire = undefined;
  await user.save();
  
  res.json({
    success: true,
    message: 'Password reset successful. You can now login with your new password.',
    userType: isProvider ? 'provider' : 'user',
    email: user.email,
    fullName: user.fullName,
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