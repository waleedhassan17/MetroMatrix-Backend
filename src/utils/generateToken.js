const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// A stolen access token is usable until it expires and cannot be revoked, so
// it should be short-lived; the long-lived refresh token IS revocable (it's
// stored on the user document and cleared on logout/password reset). The
// default used to be 30 days, which made the access token as dangerous as a
// password. The mobile client silently refreshes on 401 — see the response
// interceptor in networks/network/network.ts — so 15m is invisible to users.
const DEFAULT_ACCESS_TOKEN_EXPIRE = '15m';
const DEFAULT_REFRESH_TOKEN_EXPIRE = '90d';

/**
 * Convert a jsonwebtoken lifetime ("15m", "90d", 3600) to milliseconds, so
 * the `expiresIn` we hand the client actually describes the token we just
 * issued. It used to be a hardcoded 30-day constant that ignored JWT_EXPIRE
 * entirely — a client trusting it would treat a 15-minute token as valid for
 * a month.
 * @returns {number|null} milliseconds, or null if unparseable
 */
const expiryToMs = (value) => {
  if (value == null) return null;
  if (typeof value === 'number') return value * 1000; // jwt treats bare numbers as seconds

  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|y)?$/i.exec(String(value).trim());
  if (!match) return null;

  const amount = parseFloat(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
    y: 365 * 24 * 60 * 60 * 1000,
  };
  return amount * multipliers[unit];
};

const accessTokenExpire = () => process.env.JWT_EXPIRE || DEFAULT_ACCESS_TOKEN_EXPIRE;
const refreshTokenExpire = () =>
  process.env.REFRESH_TOKEN_EXPIRE || DEFAULT_REFRESH_TOKEN_EXPIRE;

// Every token states what it is (`typ`), and `protect` only accepts access
// tokens. Without it the two kinds were told apart solely by which secret
// signed them — so on a deployment where JWT_SECRET happened to equal
// REFRESH_TOKEN_SECRET, a 90-day refresh token worked as an access token.
// `typ` is set last so a caller's payload can never override it.

// Generate access token (short-lived)
// payload can include: { id, userType, email, tokenType, onboardingStatus, etc. }
const generateAccessToken = (id, payload = {}, { expiresIn } = {}) => {
  const tokenPayload = { id, ...payload, typ: 'access' };
  return jwt.sign(tokenPayload, process.env.JWT_SECRET, {
    expiresIn: expiresIn || accessTokenExpire(),
  });
};

// Generate refresh token (long-lived)
// payload can include: { id, userType, email, tokenType, onboardingStatus, etc. }
// `jti` makes every refresh token unique: without it, two issued for the same
// account in the same second are byte-identical, and a refresh session
// (services/refreshSessions.js) is identified by its token's hash.
const generateRefreshToken = (id, payload = {}, { expiresIn } = {}) => {
  const tokenPayload = { id, jti: crypto.randomUUID(), ...payload, typ: 'refresh' };
  return jwt.sign(tokenPayload, process.env.REFRESH_TOKEN_SECRET, {
    expiresIn: expiresIn || refreshTokenExpire(),
  });
};

/**
 * Expiry of an issued token, read from the token itself so the client is told
 * exactly what the server will enforce.
 * @returns {{ accessTokenExpiresAt: string, expiresInSeconds: number }}
 */
const describeExpiry = (token) => {
  const { exp } = jwt.decode(token) || {};
  const expiresAtMs = (exp || 0) * 1000;
  return {
    accessTokenExpiresAt: new Date(expiresAtMs).toISOString(),
    expiresInSeconds: Math.max(0, Math.round((expiresAtMs - Date.now()) / 1000)),
  };
};

// Generate both tokens
// options can include: { userType, email, tokenType, onboardingStatus, etc. }
const generateTokens = (id, options = {}) => {
  const accessToken = generateAccessToken(id, options);
  const refreshToken = generateRefreshToken(id, options);

  // Derived from the real configured lifetime, not a constant.
  const expiresIn =
    expiryToMs(accessTokenExpire()) ?? expiryToMs(DEFAULT_ACCESS_TOKEN_EXPIRE);

  return {
    accessToken,
    refreshToken,
    expiresIn, // milliseconds until the access token expires
  };
};

// Verify token
const verifyToken = (token, secret) => {
  try {
    return jwt.verify(token, secret);
  } catch (error) {
    return null;
  }
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  generateTokens,
  verifyToken,
  expiryToMs,
  describeExpiry,
  DEFAULT_ACCESS_TOKEN_EXPIRE,
};