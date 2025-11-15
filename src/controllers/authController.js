const asyncHandler = require('express-async-handler');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const Provider = require('../models/Provider');
const { generateTokens } = require('../utils/generateToken');
const { sendEmail, emailTemplates } = require('../services/emailService');

// @desc    Register user
// @route   POST /api/auth/register
// @access  Public
const registerUser = asyncHandler(async (req, res) => {
  const { fullName, phoneNumber, email, password } = req.body;
  
  // Check if user exists
  const userExists = await User.findOne({ email });
  
  if (userExists) {
    res.status(400);
    throw new Error('User already exists');
  }
  
  // Create user
  const user = await User.create({
    fullName,
    phoneNumber,
    email,
    password
  });
  
  if (user) {
    const tokens = generateTokens(user._id);
    
    // Save refresh token to database
    user.refreshToken = tokens.refreshToken;
    user.lastLoginDate = Date.now();
    await user.save();
    
    res.status(201).json({
      success: true,
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        phoneNumber: user.phoneNumber,
        profileComplete: user.profileComplete,
        isVerified: user.isVerified
      },
      ...tokens
    });
  } else {
    res.status(400);
    throw new Error('Invalid user data');
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
const registerProvider = asyncHandler(async (req, res) => {
  const { fullName, phoneNumber, email, password } = req.body;
  
  // Check if provider exists
  const providerExists = await Provider.findOne({ email });
  
  if (providerExists) {
    res.status(400);
    throw new Error('Provider already exists');
  }
  
  // Create provider
  const provider = await Provider.create({
    fullName,
    phoneNumber,
    email,
    password
  });
  
  if (provider) {
    const tokens = generateTokens(provider._id);
    
    provider.refreshToken = tokens.refreshToken;
    provider.lastLoginDate = Date.now();
    await provider.save();
    
    res.status(201).json({
      success: true,
      provider: {
        id: provider._id,
        fullName: provider.fullName,
        email: provider.email,
        phoneNumber: provider.phoneNumber,
        profileComplete: provider.profileComplete,
        verificationStatus: provider.verificationStatus
      },
      ...tokens
    });
  } else {
    res.status(400);
    throw new Error('Invalid provider data');
  }
});

// @desc    Login provider
// @route   POST /api/auth/provider/login
// @access  Public
const loginProvider = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  
  const provider = await Provider.findOne({ email }).select('+password');
  
  if (provider && (await provider.matchPassword(password))) {
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
  
  // Create reset URL
  const resetUrl = `${process.env.CLIENT_URL}/reset-password?token=${resetToken}&type=${
    isProvider ? 'provider' : 'user'
  }`;
  
  try {
    await sendEmail({
      email: user.email,
      subject: 'Password Reset Request - MetroMatrix',
      message: `You requested a password reset. Please click this link to reset your password: ${resetUrl}. This link will expire in 10 minutes.`,
    });
    
    res.json({
      success: true,
      message: 'Password reset email sent',
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
    message: 'Password reset successful',
    userType: isProvider ? 'provider' : 'user',
  });
});

// @desc    Verify email
// @route   POST /api/auth/verify-email
// @access  Public
const verifyEmail = asyncHandler(async (req, res) => {
  const { token } = req.body;
  
  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
  
  const user = await User.findOne({
    emailVerificationToken: hashedToken,
    emailVerificationExpire: { $gt: Date.now() },
  });
  
  if (!user) {
    res.status(400);
    throw new Error('Invalid or expired verification token');
  }
  
  user.isVerified = true;
  user.emailVerificationToken = undefined;
  user.emailVerificationExpire = undefined;
  await user.save();
  
  res.json({
    success: true,
    message: 'Email verified successfully',
  });
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
  logout,
};