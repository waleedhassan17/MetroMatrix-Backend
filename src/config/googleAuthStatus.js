/**
 * Shared, in-memory snapshot of how Google OAuth is wired on this instance.
 * Populated once by config/passport.js at module load (cold start), read by
 * GET /api/auth/health and by the /google, /google/callback route guards so
 * they can fail cleanly (503) instead of passport throwing on an
 * unregistered strategy. Never put secret values in here.
 */
const googleAuthStatus = {
  configured: false,
  callbackURL: null,
};

module.exports = googleAuthStatus;
