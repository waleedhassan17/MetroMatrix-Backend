const mongoose = require('mongoose');

/**
 * One signed-in admin device. Replaces the single plaintext
 * Admin.refreshToken, which meant one session per admin (a second login
 * silently killed the first), no way to list or revoke sessions, and a
 * readable live credential in every Admin document.
 *
 * Only a SHA-256 of the current refresh token is stored. The token rotates on
 * every refresh; presenting a previous token of a live session is treated as
 * theft (reuse detection) and revokes the session.
 */
const adminSessionSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true, index: true },
    refreshTokenHash: { type: String, required: true },
    deviceLabel: { type: String, default: '', maxlength: 120 },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '', maxlength: 300 },
    // Last authenticated API call (not refreshes) — drives the idle timeout.
    lastUsedAt: { type: Date, default: Date.now },
    lastRefreshedAt: { type: Date, default: null },
    // Absolute end of the session, whatever the activity.
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: {
      type: String,
      enum: [
        null,
        'logout',
        'logout_all',
        'idle_timeout',
        'refresh_reuse',
        'password_changed',
        'password_reset',
        'deactivated',
        'role_changed',
        'revoked_by_self',
        'revoked_by_admin',
        'two_factor_changed',
      ],
      default: null,
    },
  },
  { timestamps: true }
);

adminSessionSchema.index({ admin: 1, revokedAt: 1, expiresAt: -1 });
// Expired sessions are kept 30 days for the session history, then dropped.
adminSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

adminSessionSchema.methods.isLive = function (now = new Date()) {
  return !this.revokedAt && this.expiresAt > now;
};

// Safe to return to the admin: never the token hash.
adminSessionSchema.methods.toPublic = function (currentSessionId) {
  return {
    id: String(this._id),
    deviceLabel: this.deviceLabel || null,
    ip: this.ip || null,
    userAgent: this.userAgent || null,
    createdAt: this.createdAt,
    lastUsedAt: this.lastUsedAt,
    expiresAt: this.expiresAt,
    revokedAt: this.revokedAt,
    revokedReason: this.revokedReason,
    current: currentSessionId ? String(this._id) === String(currentSessionId) : false,
  };
};

module.exports = mongoose.model('AdminSession', adminSessionSchema);
