const asyncHandler = require('express-async-handler');
const Provider = require('../models/Provider');

// Middleware to check if provider has LIMITED or FULL access based on onboarding status
// LIMITED access: Can ONLY use /personal-info endpoint
// FULL access: Can use all features after approval

/**
 * Allows LIMITED token access (personal-info endpoint only)
 * Used for: POST /api/providers/personal-info
 * Includes provider check to ensure only providers can access
 */
const allowLimitedOrFullToken = asyncHandler(async (req, res, next) => {
  // Check if user exists
  if (!req.user) {
    res.status(401);
    throw new Error('Not authorized. Please login first.');
  }

  // Check if user is a provider (either from req.isProvider flag or from userType in token)
  const isProvider = req.isProvider || req.user.constructor.modelName === 'Provider';
  
  if (!isProvider) {
    res.status(403);
    throw new Error('This route is only for providers');
  }

  // Fetch provider to check onboarding status
  const provider = await Provider.findById(req.user._id);
  
  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }

  // Allow if: pending_profile, pending_approval, or approved
  const allowedStatuses = ['pending_profile', 'pending_approval', 'approved'];
  
  if (!allowedStatuses.includes(provider.onboardingStatus)) {
    res.status(403);
    throw new Error('You do not have permission to access this endpoint. Please complete email verification.');
  }

  // Store provider in request for later use
  req.provider = provider;
  
  // Indicate token type in response headers
  if (provider.onboardingStatus === 'approved') {
    res.set('X-Token-Type', 'FULL');
  } else {
    res.set('X-Token-Type', 'LIMITED');
  }
  
  next();
});

/**
 * Requires FULL token access (full provider features)
 * Used for: Dashboard, bookings, orders, etc.
 */
const requireFullToken = asyncHandler(async (req, res, next) => {
  // Check if user exists
  if (!req.user) {
    res.status(401);
    throw new Error('Not authorized. Please login first.');
  }

  // Check if user is a provider
  const isProvider = req.isProvider || req.user.constructor.modelName === 'Provider';
  
  if (!isProvider) {
    res.status(403);
    throw new Error('This route is only for providers');
  }

  // Fetch provider to check onboarding status
  const provider = await Provider.findById(req.user._id);
  
  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }

  // Only allow if onboarding status is approved
  if (provider.onboardingStatus !== 'approved') {
    res.status(403);
    throw new Error(
      `You do not have full access yet. Current status: ${provider.onboardingStatus}. ` +
      `${provider.onboardingStatus === 'pending_profile' 
        ? 'Please submit your personal information.' 
        : 'Please wait for admin approval.'}`
    );
  }

  // Store provider in request
  req.provider = provider;
  res.set('X-Token-Type', 'FULL');
  next();
});

/**
 * Get provider onboarding status for permission checking
 */
const getProviderStatus = asyncHandler(async (req, res, next) => {
  if (req.user && req.user.constructor.modelName === 'Provider') {
    const provider = await Provider.findById(req.user.id).select('onboardingStatus verificationStatus');
    req.providerStatus = {
      onboardingStatus: provider?.onboardingStatus || 'unknown',
      verificationStatus: provider?.verificationStatus || 'unknown',
    };
  }
  next();
});

module.exports = {
  allowLimitedOrFullToken,
  requireFullToken,
  getProviderStatus,
};
