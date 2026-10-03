const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const Provider = require('../models/Provider');
const Admin = require('../models/Admin');
const named = require('../utils/named');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const { ERROR_CODES } = require('../utils/errorCodes');
const { loadActiveSession } = require('../services/admin/sessionService');
const { sessionRestriction, allowedWhileRestricted } = require('../services/admin/sessionRestrictions');

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

// Only access tokens authenticate requests. Refresh tokens (`typ: 'refresh'`)
// and sign-in challenge tokens (`typ: 'mfa'`) are refused even if they verify;
// tokens issued before `typ` existed carry none and are still accepted.
const isAccessToken = (decoded) => !decoded.typ || decoded.typ === 'access';

const RESTRICTION_ERROR = {
  password_change: [ERROR_CODES.PASSWORD_CHANGE_REQUIRED, 'Set a new password before continuing.'],
  totp_enrol: [ERROR_CODES.TOTP_ENROLMENT_REQUIRED, 'Set up two-factor sign-in before continuing.'],
};

// Protect routes
const protect = named(
  'protect',
  asyncHandler(async (req, res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer')) {
      res.status(401);
      throw new Error('Not authorized, no token');
    }

    let decoded;
    let user;
    let kind;
    try {
      decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
      if (!isAccessToken(decoded)) throw new Error(`a ${decoded.typ} token is not an access token`);
      ({ account: user, kind } = await loadAccount(decoded));
      if (!user) throw new Error('account not found');
      if (!user.isActive) throw new Error('account is deactivated');
    } catch (error) {
      // Expired/forged tokens are routine (the client refreshes on 401);
      // logging each one at error level only buried real faults.
      (req.log || logger).debug({ err: error }, 'token rejected');
      res.status(401);
      throw new Error('Not authorized, token failed');
    }

    applyAccountKind(req, kind);

    if (kind === 'admin') {
      // Admin tokens are tied to a live AdminSession: revoking the session
      // (logout, password change, deactivation, refresh-token reuse, idle
      // timeout) ends access on the next request, not when the token expires.
      if (!decoded.sid) {
        throw new AppError(ERROR_CODES.SESSION_REVOKED, 'Please sign in again.');
      }
      const { session, security } = await loadActiveSession(decoded.sid, user._id);
      req.adminSession = session;

      const restriction = sessionRestriction(user, security);
      req.sessionRestriction = restriction;
      if (restriction && !allowedWhileRestricted(req, restriction)) {
        const [code, message] = RESTRICTION_ERROR[restriction];
        throw new AppError(code, message);
      }
    }

    req.user = user;
    next();
  })
);

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

/**
 * Require Admin.permissions flags — ALL of the ones listed. A super admin has
 * every flag (Admin.hasPermission). Run after protect.
 *
 * The returned middleware is named `requirePermission(flagA+flagB)` so the
 * route table (docs/ROUTES.json) and the admin route-guard test can see which
 * permission guards each route.
 */
const requirePermission = (...permissions) =>
  named(`requirePermission(${permissions.join('+')})`, (req, res, next) => {
    if (!req.isAdmin) {
      res.status(403);
      throw new Error('This route is for admins only');
    }
    const missing = permissions.find((p) => !req.user.hasPermission(p));
    if (missing) {
      throw new AppError(ERROR_CODES.FORBIDDEN, `You do not have the '${missing}' permission`, {
        details: { permission: missing },
      });
    }
    next();
  });

// Super-admin-only actions: creating or disabling admins, changing roles or
// permissions, security settings, approving large wallet adjustments. No
// permission flag can grant these.
const requireSuperAdmin = named('requireSuperAdmin', (req, res, next) => {
  if (!req.isAdmin) {
    res.status(403);
    throw new Error('This route is for admins only');
  }
  if (!req.user.isSuperAdmin) {
    throw new AppError(ERROR_CODES.SUPER_ADMIN_REQUIRED, 'Only a super admin can do this');
  }
  next();
});

// Marks an admin route that acts only on the caller's own account (profile,
// password, sessions, two-factor, own notification state) — the explicit
// alternative to a permission guard, checked by the route-guard test.
const selfScoped = named('selfScoped', (req, res, next) => next());

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
const optionalAuth = named('optionalAuth', asyncHandler(async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (!isAccessToken(decoded)) throw new Error('not an access token');

      const { account: user, kind } = await loadAccount(decoded);
      if (user) applyAccountKind(req, kind);

      if (user && user.isActive) {
        req.user = user;
      }
    } catch (error) {
      // Don't throw error, just continue without user
      logger.debug('Optional auth: Invalid token');
    }
  }

  next();
}));

module.exports = {
  loadAccount,
  protect,
  userOnly,
  providerOnly,
  adminOnly,
  requirePermission,
  requireSuperAdmin,
  selfScoped,
  verifiedProvider,
  optionalAuth
};
