const crypto = require('crypto');
const Admin = require('../../models/Admin');
const AdminSession = require('../../models/AdminSession');
const AppError = require('../../utils/AppError');
const { ERROR_CODES } = require('../../utils/errorCodes');
const {
  generateAccessToken,
  generateRefreshToken,
  describeExpiry,
  expiryToMs,
  verifyToken,
} = require('../../utils/generateToken');
const { getSecuritySettings } = require('../settingsCache');
const { audit } = require('../auditService');

/**
 * Admin sessions: one AdminSession document per signed-in device.
 *
 * - Access tokens carry `sid`; `protect` checks the session is live on every
 *   admin request, so revoking a session (logout, password change,
 *   deactivation, reuse) takes effect on the very next request.
 * - The refresh token rotates on every use and only its hash is stored. A
 *   refresh token that verifies but is not the session's current one is a
 *   replay of a rotated token — the session is revoked (reuse detection).
 * - Idle timeout (security.sessionTimeout) counts real API activity
 *   (lastUsedAt); a background refresh is not activity.
 * - Absolute lifetime: ADMIN_SESSION_MAX_AGE (default 7d).
 */

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sessionMaxAgeMs = () => expiryToMs(process.env.ADMIN_SESSION_MAX_AGE || '7d');
const TOUCH_INTERVAL_MS = 60 * 1000;

const invalidRefresh = () => new AppError(ERROR_CODES.TOKEN_INVALID, 'Your sign-in has expired. Please sign in again.');

function issueTokens(admin, session) {
  const sid = String(session._id);
  const accessToken = generateAccessToken(admin._id, { userType: 'admin', role: admin.role, sid });
  const remainingSeconds = Math.max(1, Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000));
  const refreshToken = generateRefreshToken(
    admin._id,
    { userType: 'admin', sid, jti: crypto.randomUUID() },
    { expiresIn: remainingSeconds }
  );
  return { accessToken, refreshToken, ...describeExpiry(accessToken), sessionId: sid };
}

function deviceInfo(req, deviceLabel) {
  return {
    deviceLabel: typeof deviceLabel === 'string' ? deviceLabel.trim().slice(0, 120) : '',
    ip: req.ip || '',
    userAgent: (req.get?.('user-agent') || '').slice(0, 300),
  };
}

async function createSession(admin, req, { deviceLabel } = {}) {
  const now = Date.now();
  const session = new AdminSession({
    admin: admin._id,
    refreshTokenHash: 'pending',
    ...deviceInfo(req, deviceLabel),
    lastUsedAt: new Date(now),
    expiresAt: new Date(now + sessionMaxAgeMs()),
  });
  const tokens = issueTokens(admin, session);
  session.refreshTokenHash = sha256(tokens.refreshToken);
  await session.save();
  return { tokens, session };
}

const isIdle = (session, security, now = Date.now()) =>
  security.sessionTimeout > 0 && now - new Date(session.lastUsedAt).getTime() > security.sessionTimeout * 60 * 1000;

async function revoke(sessionOrId, reason) {
  const id = sessionOrId?._id || sessionOrId;
  await AdminSession.updateOne({ _id: id, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });
}

async function revokeAll(adminId, reason, { exceptSessionId } = {}) {
  const filter = { admin: adminId, revokedAt: null, expiresAt: { $gt: new Date() } };
  if (exceptSessionId) filter._id = { $ne: exceptSessionId };
  const { modifiedCount } = await AdminSession.updateMany(filter, { $set: { revokedAt: new Date(), revokedReason: reason } });
  return modifiedCount;
}

/**
 * Exchange a refresh token for a new pair (rotation).
 * @returns {{ tokens, admin, session }}
 */
async function rotate(refreshToken, req) {
  const decoded = typeof refreshToken === 'string' ? verifyToken(refreshToken, process.env.REFRESH_TOKEN_SECRET) : null;
  if (!decoded || decoded.typ !== 'refresh' || decoded.userType !== 'admin' || !decoded.sid) throw invalidRefresh();

  const session = await AdminSession.findById(decoded.sid);
  if (!session || String(session.admin) !== String(decoded.id)) throw invalidRefresh();
  if (!session.isLive()) {
    throw new AppError(ERROR_CODES.SESSION_REVOKED, 'This session has been signed out. Please sign in again.');
  }

  const presentedHash = sha256(refreshToken);
  if (session.refreshTokenHash !== presentedHash) {
    await revoke(session, 'refresh_reuse');
    await audit(req, {
      action: 'admin.session.reuse_detected',
      module: 'auth',
      targetType: 'AdminSession',
      targetId: session._id,
      actor: { _id: session.admin },
      meta: { sessionId: String(session._id) },
    });
    throw new AppError(
      ERROR_CODES.SESSION_REVOKED,
      'This session was signed out because an old sign-in token was used again. Please sign in again.'
    );
  }

  const security = await getSecuritySettings();
  if (isIdle(session, security)) {
    await revoke(session, 'idle_timeout');
    throw new AppError(ERROR_CODES.SESSION_IDLE_TIMEOUT, 'You were signed out after a period of inactivity.');
  }

  const admin = await Admin.findById(session.admin);
  if (!admin || !admin.isActive) {
    await revoke(session, 'deactivated');
    throw new AppError(ERROR_CODES.ACCOUNT_DEACTIVATED, 'This admin account has been deactivated.');
  }

  const tokens = issueTokens(admin, session);
  const updated = await AdminSession.findOneAndUpdate(
    { _id: session._id, refreshTokenHash: presentedHash, revokedAt: null },
    { $set: { refreshTokenHash: sha256(tokens.refreshToken), lastRefreshedAt: new Date() } },
    { new: true }
  );
  if (!updated) {
    // Another request rotated this same token first: the token was presented
    // twice. Same treatment as reuse.
    await revoke(session, 'refresh_reuse');
    throw new AppError(ERROR_CODES.SESSION_REVOKED, 'This session was signed out. Please sign in again.');
  }
  return { tokens, admin, session: updated };
}

/**
 * For `protect`: the live session behind an admin access token, or throw.
 * Also enforces the idle timeout and records activity.
 */
async function loadActiveSession(sid, adminId) {
  const session = sid ? await AdminSession.findById(sid) : null;
  if (!session || String(session.admin) !== String(adminId) || !session.isLive()) {
    throw new AppError(ERROR_CODES.SESSION_REVOKED, 'This session has been signed out. Please sign in again.');
  }
  const security = await getSecuritySettings();
  const now = Date.now();
  if (isIdle(session, security, now)) {
    await revoke(session, 'idle_timeout');
    throw new AppError(ERROR_CODES.SESSION_IDLE_TIMEOUT, 'You were signed out after a period of inactivity.');
  }
  if (now - new Date(session.lastUsedAt).getTime() > TOUCH_INTERVAL_MS) {
    await AdminSession.updateOne({ _id: session._id }, { $set: { lastUsedAt: new Date(now) } });
  }
  return { session, security };
}

module.exports = { createSession, rotate, revoke, revokeAll, loadActiveSession, issueTokens, sha256 };
