const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const Admin = require('../../models/Admin');
const AdminSession = require('../../models/AdminSession');
const AppError = require('../../utils/AppError');
const { ERROR_CODES } = require('../../utils/errorCodes');
const { ok } = require('../../utils/apiResponse');
const { verifyToken } = require('../../utils/generateToken');
const { SALT_ROUNDS } = require('../../utils/hashPassword');
const { getSecuritySettings } = require('../../services/settingsCache');
const { audit } = require('../../services/auditService');
const throttle = require('../../services/admin/loginThrottle');
const sessions = require('../../services/admin/sessionService');
const totp = require('../../services/admin/totp');
const { assertStrongPassword } = require('../../services/admin/passwordPolicy');
const { sessionRestriction } = require('../../services/admin/sessionRestrictions');
const { presentAdmin } = require('../../services/admin/presenter');

/*
 * Admin authentication — /api/admin/auth/*, /api/admin/sessions,
 * /api/admin/profile, /api/admin/change-password.
 *
 * Sign-in:  POST /auth/login {email, password, deviceLabel?}
 *             → tokens, or { step: 'totp_required', challengeToken } when the
 *               admin has two-factor sign-in on
 *           POST /auth/login/totp {challengeToken, code | recoveryCode}
 *             → tokens
 * Tokens:   { accessToken, refreshToken, accessTokenExpiresAt, expiresInSeconds,
 *             sessionId, restrict, admin }
 *           `restrict` ('password_change' | 'totp_enrol' | null) says what the
 *           admin must do before the rest of the console opens up.
 */

const normaliseEmail = (email) => String(email || '').trim().toLowerCase();

// Per-address cap on failed sign-ins (on top of the per-account lockout).
const IP_MAX_FAILURES = Number(process.env.ADMIN_LOGIN_IP_MAX_FAILURES || 20);
const IP_WINDOW_MS = 15 * 60 * 1000;
const MFA_MAX_FAILURES = 5;
const MFA_CHALLENGE_TTL = '5m';

// Comparing against a real-cost hash when the email is unknown keeps the
// response time the same, so timing doesn't reveal which emails are admins.
let dummyHash;
const dummyCompare = async (password) => {
  dummyHash = dummyHash || (await bcrypt.hash(crypto.randomBytes(16).toString('hex'), SALT_ROUNDS));
  await bcrypt.compare(String(password || ''), dummyHash);
};

const tooManyAttempts = (retryAfterSeconds) =>
  new AppError(ERROR_CODES.TOO_MANY_ATTEMPTS, 'Too many failed sign-in attempts. Try again later.', {
    details: { retryAfterSeconds },
    headers: { 'Retry-After': String(retryAfterSeconds) },
  });

const emailHash = (email) => crypto.createHash('sha256').update(email).digest('hex').slice(0, 16);

async function refuseIfLocked(keys) {
  for (const key of keys) {
    const status = await throttle.lockStatus(key);
    if (status.locked) return status;
  }
  return null;
}

// Issue a session and the response body every successful sign-in returns.
async function completeSignIn(req, admin, security) {
  const { tokens, session } = await sessions.createSession(admin, req, { deviceLabel: req.body.deviceLabel });
  await Admin.updateOne({ _id: admin._id }, { $set: { lastLoginDate: new Date() } });
  admin.lastLoginDate = new Date();
  await audit(req, {
    action: 'admin.login.succeeded',
    module: 'auth',
    targetType: 'AdminSession',
    targetId: session._id,
    actor: admin,
  });
  return { ...tokens, restrict: sessionRestriction(admin, security), admin: presentAdmin(admin) };
}

// @route POST /api/admin/auth/login   (alias: POST /api/admin/login)
const login = asyncHandler(async (req, res) => {
  const email = normaliseEmail(req.body.email);
  const { password } = req.body;
  const security = await getSecuritySettings();
  const lockMs = security.lockoutMinutes * 60 * 1000;
  const emailKey = `email:${email}`;
  const ipKey = `ip:${req.ip}`;

  const locked = await refuseIfLocked([ipKey, emailKey]);
  if (locked) {
    await audit(req, { action: 'admin.login.blocked', module: 'auth', actor: null, meta: { emailHash: emailHash(email) } });
    throw tooManyAttempts(locked.retryAfterSeconds);
  }

  const admin = await Admin.findOne({ email }).select('+password');
  const passwordOk = admin ? await admin.matchPassword(password) : (await dummyCompare(password), false);

  if (!passwordOk) {
    const [perAccount] = await Promise.all([
      throttle.registerFailure(emailKey, { max: security.maxLoginAttempts, windowMs: lockMs, lockMs }),
      throttle.registerFailure(ipKey, { max: IP_MAX_FAILURES, windowMs: IP_WINDOW_MS, lockMs: IP_WINDOW_MS }),
    ]);
    await audit(req, {
      action: 'admin.login.failed',
      module: 'auth',
      actor: null,
      targetType: admin ? 'Admin' : null,
      targetId: admin?._id || null,
      meta: { emailHash: emailHash(email), failures: perAccount.count },
    });
    if (perAccount.lockedNow) {
      await audit(req, {
        action: 'admin.login.locked',
        module: 'auth',
        actor: null,
        targetType: admin ? 'Admin' : null,
        targetId: admin?._id || null,
        meta: { emailHash: emailHash(email), lockedUntil: perAccount.lockedUntil },
      });
    }
    throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 'Invalid email or password');
  }

  // Only now — after the password proved who this is — say it's deactivated.
  if (!admin.isActive) {
    await audit(req, { action: 'admin.login.denied_deactivated', module: 'auth', actor: null, targetType: 'Admin', targetId: admin._id });
    throw new AppError(ERROR_CODES.ACCOUNT_DEACTIVATED, 'This admin account has been deactivated.');
  }

  await throttle.clear(emailKey);

  if (admin.twoFactor?.enabled) {
    const challengeToken = jwt.sign({ id: String(admin._id), userType: 'admin', typ: 'mfa' }, process.env.JWT_SECRET, {
      expiresIn: MFA_CHALLENGE_TTL,
    });
    return ok(res, { step: 'totp_required', challengeToken, expiresInSeconds: 300 });
  }

  return ok(res, { step: 'signed_in', ...(await completeSignIn(req, admin, security)) });
});

// @route POST /api/admin/auth/login/totp
const loginTotp = asyncHandler(async (req, res) => {
  const { challengeToken, code, recoveryCode } = req.body;
  const decoded = typeof challengeToken === 'string' ? verifyToken(challengeToken, process.env.JWT_SECRET) : null;
  if (!decoded || decoded.typ !== 'mfa' || decoded.userType !== 'admin') {
    throw new AppError(ERROR_CODES.TOKEN_INVALID, 'This sign-in attempt has expired. Please start again.');
  }

  const admin = await Admin.findById(decoded.id).select(
    '+twoFactor.secretEnc +twoFactor.recoveryCodeHashes +twoFactor.lastUsedCounter'
  );
  if (!admin || !admin.twoFactor?.enabled) {
    throw new AppError(ERROR_CODES.TOKEN_INVALID, 'This sign-in attempt has expired. Please start again.');
  }
  if (!admin.isActive) throw new AppError(ERROR_CODES.ACCOUNT_DEACTIVATED, 'This admin account has been deactivated.');

  const mfaKey = `mfa:${admin._id}`;
  const security = await getSecuritySettings();
  const lockMs = security.lockoutMinutes * 60 * 1000;
  const locked = await refuseIfLocked([mfaKey]);
  if (locked) throw tooManyAttempts(locked.retryAfterSeconds);

  let accepted = false;
  if (code) {
    const counter = totp.verifyTotp(totp.decryptSecret(admin.twoFactor.secretEnc), code, {
      lastUsedCounter: admin.twoFactor.lastUsedCounter || 0,
    });
    if (counter !== null) {
      accepted = true;
      await Admin.updateOne({ _id: admin._id }, { $set: { 'twoFactor.lastUsedCounter': counter } });
    }
  } else if (recoveryCode) {
    const hash = totp.hashRecoveryCode(recoveryCode);
    // Atomic: a recovery code works exactly once.
    const { modifiedCount } = await Admin.updateOne(
      { _id: admin._id, 'twoFactor.recoveryCodeHashes': hash },
      { $pull: { 'twoFactor.recoveryCodeHashes': hash } }
    );
    accepted = modifiedCount === 1;
    if (accepted) {
      await audit(req, { action: 'admin.login.recovery_code_used', module: 'auth', actor: admin, targetType: 'Admin', targetId: admin._id });
    }
  }

  if (!accepted) {
    const result = await throttle.registerFailure(mfaKey, { max: MFA_MAX_FAILURES, windowMs: lockMs, lockMs });
    await audit(req, {
      action: 'admin.login.totp_failed',
      module: 'auth',
      actor: null,
      targetType: 'Admin',
      targetId: admin._id,
      meta: { failures: result.count },
    });
    throw new AppError(ERROR_CODES.TOTP_INVALID, 'That code is not valid. Check your authenticator app and try again.');
  }

  await throttle.clear(mfaKey);
  return ok(res, { step: 'signed_in', ...(await completeSignIn(req, admin, security)) });
});

// @route POST /api/admin/auth/refresh-token   (public — the access token may have expired)
const refresh = asyncHandler(async (req, res) => {
  const { tokens, admin } = await sessions.rotate(req.body.refreshToken, req);
  const security = await getSecuritySettings();
  return ok(res, { ...tokens, restrict: sessionRestriction(admin, security), admin: presentAdmin(admin) });
});

// @route POST /api/admin/auth/logout
const logout = asyncHandler(async (req, res) => {
  await sessions.revoke(req.adminSession, 'logout');
  await audit(req, { action: 'admin.logout', module: 'auth', targetType: 'AdminSession', targetId: req.adminSession._id });
  return ok(res, { signedOut: 1 });
});

// @route POST /api/admin/auth/logout-all
const logoutAll = asyncHandler(async (req, res) => {
  const count = await sessions.revokeAll(req.user._id, 'logout_all');
  await audit(req, { action: 'admin.logout_all', module: 'auth', targetType: 'Admin', targetId: req.user._id, meta: { sessions: count } });
  return ok(res, { signedOut: count });
});

// @route GET /api/admin/sessions
const listSessions = asyncHandler(async (req, res) => {
  const live = await AdminSession.find({ admin: req.user._id, revokedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ lastUsedAt: -1 })
    .limit(50);
  return ok(res, live.map((s) => s.toPublic(req.adminSession?._id)));
});

// @route DELETE /api/admin/sessions/:sessionId
const revokeSession = asyncHandler(async (req, res) => {
  const session = await AdminSession.findOne({ _id: req.params.sessionId, admin: req.user._id });
  if (!session) throw new AppError(ERROR_CODES.NOT_FOUND, 'Session not found');
  await sessions.revoke(session, 'revoked_by_self');
  await audit(req, { action: 'admin.session.revoke', module: 'auth', targetType: 'AdminSession', targetId: session._id });
  return ok(res, { revoked: true, current: String(session._id) === String(req.adminSession?._id) });
});

// @route PUT /api/admin/change-password
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const admin = await Admin.findById(req.user._id).select('+password');
  if (!(await admin.matchPassword(currentPassword))) {
    throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 'Current password is incorrect');
  }
  assertStrongPassword(newPassword, { email: admin.email });
  if (await admin.matchPassword(newPassword)) {
    throw new AppError(ERROR_CODES.WEAK_PASSWORD, 'Choose a password different from the current one', {
      details: { problems: ['Same as the current password'] },
    });
  }

  admin.password = newPassword;
  admin.passwordChangedAt = new Date();
  admin.mustChangePassword = false;
  await admin.save();

  // Every other device has to sign in with the new password.
  const signedOut = await sessions.revokeAll(admin._id, 'password_changed', { exceptSessionId: req.adminSession._id });
  await audit(req, { action: 'admin.password.change', module: 'auth', targetType: 'Admin', targetId: admin._id, meta: { otherSessionsSignedOut: signedOut } });

  const security = await getSecuritySettings();
  return ok(res, { admin: presentAdmin(admin), restrict: sessionRestriction(admin, security), otherSessionsSignedOut: signedOut });
});

// @route GET /api/admin/profile
const getProfile = asyncHandler(async (req, res) => {
  return ok(res, presentAdmin(req.user, { restrict: req.sessionRestriction || null }));
});

// @route PUT /api/admin/profile   { fullName?, avatar?, email? + currentPassword }
const updateProfile = asyncHandler(async (req, res) => {
  const admin = await Admin.findById(req.user._id).select('+password');
  const before = { fullName: admin.fullName, email: admin.email, avatar: admin.avatar };
  const { fullName, avatar, email, currentPassword } = req.body;

  if (typeof fullName === 'string' && fullName.trim()) admin.fullName = fullName.trim().slice(0, 100);
  if (typeof avatar === 'string') {
    admin.avatar = avatar || null;
    admin.profilePhoto = avatar || null;
  }
  if (email !== undefined && normaliseEmail(email) !== admin.email) {
    // Changing the sign-in email needs the password: a stolen access token
    // must not be enough to take the account over.
    if (!(await admin.matchPassword(currentPassword))) {
      throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 'Enter your current password to change your email');
    }
    const next = normaliseEmail(email);
    if (await Admin.exists({ email: next, _id: { $ne: admin._id } })) {
      throw new AppError(ERROR_CODES.CONFLICT, 'That email is already used by another admin');
    }
    admin.email = next;
  }
  await admin.save();

  const after = { fullName: admin.fullName, email: admin.email, avatar: admin.avatar };
  await audit(req, { action: 'admin.profile.update', module: 'auth', targetType: 'Admin', targetId: admin._id, before, after });
  return ok(res, presentAdmin(admin));
});

// @route POST /api/admin/auth/2fa/enrol   { currentPassword }
const enrolTwoFactor = asyncHandler(async (req, res) => {
  const admin = await Admin.findById(req.user._id).select('+password');
  if (admin.twoFactor?.enabled) {
    throw new AppError(ERROR_CODES.CONFLICT, 'Two-factor sign-in is already on. Turn it off first to enrol a new device.');
  }
  if (!(await admin.matchPassword(req.body.currentPassword))) {
    throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 'Current password is incorrect');
  }
  const secret = totp.generateSecret();
  await Admin.updateOne({ _id: admin._id }, { $set: { 'twoFactor.pendingSecretEnc': totp.encryptSecret(secret) } });
  return ok(res, {
    secret,
    otpauthUrl: totp.otpauthUrl(secret, admin.email),
    issuer: totp.ISSUER,
    account: admin.email,
    digits: 6,
    periodSeconds: totp.STEP_SECONDS,
  });
});

// @route POST /api/admin/auth/2fa/verify   { code }
const verifyTwoFactor = asyncHandler(async (req, res) => {
  const admin = await Admin.findById(req.user._id).select('+twoFactor.pendingSecretEnc');
  if (!admin.twoFactor?.pendingSecretEnc) {
    throw new AppError(ERROR_CODES.TOTP_NOT_ENROLLED, 'Start two-factor set-up first.');
  }
  const counter = totp.verifyTotp(totp.decryptSecret(admin.twoFactor.pendingSecretEnc), req.body.code);
  if (counter === null) {
    throw new AppError(ERROR_CODES.TOTP_INVALID, 'That code is not valid. Check the time on your phone and try again.');
  }
  const { codes, hashes } = totp.generateRecoveryCodes();
  await Admin.updateOne(
    { _id: admin._id },
    {
      $set: {
        'twoFactor.enabled': true,
        'twoFactor.secretEnc': admin.twoFactor.pendingSecretEnc,
        'twoFactor.recoveryCodeHashes': hashes,
        'twoFactor.lastUsedCounter': counter,
        'twoFactor.enrolledAt': new Date(),
      },
      $unset: { 'twoFactor.pendingSecretEnc': 1 },
    }
  );
  const signedOut = await sessions.revokeAll(admin._id, 'two_factor_changed', { exceptSessionId: req.adminSession._id });
  await audit(req, { action: 'admin.2fa.enable', module: 'auth', targetType: 'Admin', targetId: admin._id, meta: { otherSessionsSignedOut: signedOut } });
  // Shown once; only hashes are stored.
  return ok(res, { enabled: true, recoveryCodes: codes });
});

// @route POST /api/admin/auth/2fa/disable   { currentPassword, code | recoveryCode }
const disableTwoFactor = asyncHandler(async (req, res) => {
  const admin = await Admin.findById(req.user._id).select(
    '+password +twoFactor.secretEnc +twoFactor.recoveryCodeHashes +twoFactor.lastUsedCounter'
  );
  if (!admin.twoFactor?.enabled) throw new AppError(ERROR_CODES.TOTP_NOT_ENROLLED, 'Two-factor sign-in is not on.');

  const security = await getSecuritySettings();
  if (security.twoFactorEnabled && admin.isSuperAdmin) {
    throw new AppError(ERROR_CODES.FORBIDDEN, 'Two-factor sign-in is required for super admins by the security policy.');
  }
  if (!(await admin.matchPassword(req.body.currentPassword))) {
    throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 'Current password is incorrect');
  }
  const { code, recoveryCode } = req.body;
  const secondFactorOk = code
    ? totp.verifyTotp(totp.decryptSecret(admin.twoFactor.secretEnc), code, { lastUsedCounter: admin.twoFactor.lastUsedCounter || 0 }) !== null
    : !!recoveryCode && (admin.twoFactor.recoveryCodeHashes || []).includes(totp.hashRecoveryCode(recoveryCode));
  if (!secondFactorOk) throw new AppError(ERROR_CODES.TOTP_INVALID, 'That code is not valid.');

  await Admin.updateOne(
    { _id: admin._id },
    {
      $set: { 'twoFactor.enabled': false, 'twoFactor.lastUsedCounter': 0 },
      $unset: { 'twoFactor.secretEnc': 1, 'twoFactor.recoveryCodeHashes': 1, 'twoFactor.pendingSecretEnc': 1, 'twoFactor.enrolledAt': 1 },
    }
  );
  await audit(req, { action: 'admin.2fa.disable', module: 'auth', targetType: 'Admin', targetId: admin._id });
  return ok(res, { enabled: false });
});

module.exports = {
  login,
  loginTotp,
  refresh,
  logout,
  logoutAll,
  listSessions,
  revokeSession,
  changePassword,
  getProfile,
  updateProfile,
  enrolTwoFactor,
  verifyTwoFactor,
  disableTwoFactor,
};
