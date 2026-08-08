const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 10;

/**
 * Shared `pre('save')` password hook for User, Provider and Admin.
 *
 * All three models used to inline this, and all three shared the same bug:
 *
 *   if (!this.isModified('password')) { next(); }   // <-- no `return`
 *   this.password = await bcrypt.hash(this.password, salt);
 *
 * Without the `return`, execution fell through and re-hashed the ALREADY
 * hashed password on every subsequent save(). loginUser/loginProvider both
 * do `.select('+password')` and then `save()` to record refreshToken and
 * lastLoginDate, so a single successful login corrupted the stored hash and
 * every later attempt returned INVALID_CREDENTIALS. It also called
 * bcrypt.hash(undefined) for social accounts (no password) and for any doc
 * loaded without `+password`, which rejects inside an already-continued
 * hook.
 *
 * Guarding on both conditions — and returning from each — is the whole fix.
 */
async function hashPasswordPreSave(next) {
  if (!this.isModified('password')) return next();

  // Social accounts (googleId/facebookId) legitimately have no password.
  if (!this.password) return next();

  try {
    const salt = await bcrypt.genSalt(SALT_ROUNDS);
    this.password = await bcrypt.hash(this.password, salt);
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { hashPasswordPreSave, SALT_ROUNDS };
