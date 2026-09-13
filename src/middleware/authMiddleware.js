const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const Provider = require('../models/Provider');
const Admin = require('../models/Admin');

// Which collection to look in first, keyed by the token's `userType`.
//
// Every request used to try User, then Provider, then Admin — one sequential
// round trip per miss, so every provider request paid for a User lookup that
// could never succeed before its own. Every sign-in path (and /auth/refresh)
// signs `userType`, so the token already says where the account lives. The
// remaining collections stay as a fallback: a token without `userType`, or one
// whose account type changed, still resolves exactly as it did before.
const LEGACY_ORDER = ['user', 'provider', 'admin'];
const ORDER_BY_USER_TYPE = {
  user: LEGACY_ORDER,
  provider: ['provider', 'user', 'admin'],
  admin: ['admin', 'user', 'provider'],
};

/**
 * Resolve the account a verified token belongs to.
 *
 * Returns HYDRATED documents on purpose: logout, admin permission checks and
 * checkout call methods and `save()` on `req.user`.
 *
 * @returns {Promise<{ account: object|null, kind: 'user'|'provider'|'admin'|null }>}
 */
async function loadAccount(decoded) {
  const models = { user: User, provider: Provider, admin: Admin };
  const order = ORDER_BY_USER_TYPE[decoded?.userType] || LEGACY_ORDER;
  for (const kind of order) {
    const account = await models[kind].findById(decoded.id).select('-password');
    if (account) return { account, kind };
  }
  return { account: null, kind: null };
}

function applyAccountKind(req, kind) {
  req.isProvider = kind === 'provider';
  req.isAdmin = kind === 'admin';
}

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

      const { account: user, kind } = await loadAccount(decoded);
      if (user) applyAccountKind(req, kind);

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

// User only middleware. Name the account type the caller actually presented —
// a bare "users only" gives the client no way to tell a wrong-token bug from a
// genuinely wrong account, which is exactly how a stale admin/provider token
// got mistaken for a broken cart.
const userOnly = (req, res, next) => {
  if (req.isProvider || req.isAdmin) {
    const actual = req.isAdmin ? 'an admin' : 'a provider';
    res.status(403);
    throw new Error(
      `This route is for user accounts only — you are signed in as ${actual}. Sign in with a user account to continue.`
    );
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

// Admin only middleware
const adminOnly = (req, res, next) => {
  if (!req.isAdmin) {
    res.status(403);
    throw new Error('This route is for admins only');
  }
  next();
};

// Enforce a specific Admin.permissions.<name> flag (isSuperAdmin bypasses
// all of them, matching Admin.hasPermission). Run after adminOnly — a
// stored-but-unchecked permission is the same as no permission at all.
const requirePermission = (permission) => (req, res, next) => {
  if (!req.isAdmin) {
    res.status(403);
    throw new Error('This route is for admins only');
  }
  if (!req.user.hasPermission(permission)) {
    res.status(403);
    throw new Error(`You do not have the '${permission}' permission`);
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

      const { account: user, kind } = await loadAccount(decoded);
      if (user) applyAccountKind(req, kind);

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
  loadAccount,
  protect,
  userOnly,
  providerOnly,
  adminOnly,
  requirePermission,
  verifiedProvider,
  optionalAuth
};