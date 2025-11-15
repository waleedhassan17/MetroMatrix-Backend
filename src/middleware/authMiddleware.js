const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const Provider = require('../models/Provider');

// Protect routes
const protect = asyncHandler(async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      // Get token from header
      token = req.headers.authorization.split(' ')[1];

      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Get user from the token
      let user = await User.findById(decoded.id).select('-password');
      
      if (!user) {
        // Try to find provider if not a user
        user = await Provider.findById(decoded.id).select('-password');
        if (user) {
          req.isProvider = true;
        }
      } else {
        req.isProvider = false;
      }

      if (!user) {
        res.status(401);
        throw new Error('Not authorized');
      }

      if (!user.isActive) {
        res.status(401);
        throw new Error('Account is deactivated');
      }

      req.user = user;
      next();
    } catch (error) {
      console.error(error);
      res.status(401);
      throw new Error('Not authorized, token failed');
    }
  }

  if (!token) {
    res.status(401);
    throw new Error('Not authorized, no token');
  }
});

// User only middleware
const userOnly = (req, res, next) => {
  if (req.isProvider) {
    res.status(403);
    throw new Error('This route is for users only');
  }
  next();
};

// Provider only middleware
const providerOnly = (req, res, next) => {
  if (!req.isProvider) {
    res.status(403);
    throw new Error('This route is for providers only');
  }
  next();
};

// Check if provider is verified
const verifiedProvider = (req, res, next) => {
  if (!req.isProvider) {
    res.status(403);
    throw new Error('This route is for providers only');
  }
  
  if (req.user.verificationStatus !== 'approved') {
    res.status(403);
    throw new Error('Provider account is not verified yet');
  }
  
  next();
};

// Optional auth - doesn't fail if no token
const optionalAuth = asyncHandler(async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      let user = await User.findById(decoded.id).select('-password');
      
      if (!user) {
        user = await Provider.findById(decoded.id).select('-password');
        if (user) {
          req.isProvider = true;
        }
      } else {
        req.isProvider = false;
      }
      
      if (user && user.isActive) {
        req.user = user;
      }
    } catch (error) {
      // Don't throw error, just continue without user
      console.log('Optional auth: Invalid token');
    }
  }
  
  next();
});

module.exports = {
  protect,
  userOnly,
  providerOnly,
  verifiedProvider,
  optionalAuth
};