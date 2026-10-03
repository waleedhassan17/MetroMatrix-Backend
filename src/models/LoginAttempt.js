const mongoose = require('mongoose');

/**
 * Failed-attempt counters for admin sign-in, keyed by subject:
 *   email:<normalised email>   per-account lockout (security.maxLoginAttempts)
 *   ip:<address>               per-address cap
 *   mfa:<adminId>              second-factor guesses
 *
 * Lives in MongoDB rather than express-rate-limit's default in-memory store,
 * which on Vercel is per serverless instance — every cold start reset it and
 * concurrent instances each counted separately.
 */
const loginAttemptSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  count: { type: Number, default: 0 },
  windowStartedAt: { type: Date, default: null },
  lockedUntil: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
});

loginAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('LoginAttempt', loginAttemptSchema);
