const crypto = require('crypto');
const asyncHandler = require('express-async-handler');
const Admin = require('../../models/Admin');
const AdminSession = require('../../models/AdminSession');
const AdminAuditLog = require('../../models/AdminAuditLog');
const AppError = require('../../utils/AppError');
const { ERROR_CODES } = require('../../utils/errorCodes');
const { ok, created } = require('../../utils/apiResponse');
const { ROLE_PRESETS, PERMISSION_KEYS, ROLES } = require('../../config/adminRoles');
const { audit, diff } = require('../../services/auditService');
const sessions = require('../../services/admin/sessionService');
const { presentAdmin } = require('../../services/admin/presenter');

/*
 * Admin management — /api/admin/admins/*.
 *
 * Rules (enforced here, on top of the route guards):
 *  - listing/viewing admins, disabling them and revoking their sessions needs
 *    canManageAdmins; creating admins and changing a role or permissions is
 *    super-admin only;
 *  - nobody changes their own role, permissions or active state;
 *  - acting on a super admin needs a super admin;
 *  - the last active super admin can't be demoted or disabled;
 *  - new admins and password resets get a temporary password, returned once,
 *    with mustChangePassword — their first session can only change it;
 *  - disabling, demoting, resetting a password or 2FA signs the admin out
 *    everywhere.
 */

const ROLE_VALUES = ROLES.map((r) => r.value);
const temporaryPassword = () => `${crypto.randomBytes(12).toString('base64url')}-${crypto.randomInt(10, 99)}`;
const isSelf = (req, admin) => String(req.user._id) === String(admin._id);

async function loadTarget(req) {
  const admin = await Admin.findById(req.params.adminId);
  if (!admin) throw new AppError(ERROR_CODES.NOT_FOUND, 'Admin not found');
  if (admin.isSuperAdmin && !req.user.isSuperAdmin) {
    throw new AppError(ERROR_CODES.SUPER_ADMIN_REQUIRED, 'Only a super admin can act on another super admin');
  }
  return admin;
}

async function assertNotLastSuperAdmin(admin) {
  const others = await Admin.countDocuments({ role: 'super_admin', isActive: true, _id: { $ne: admin._id } });
  if (others === 0) {
    throw new AppError(ERROR_CODES.LAST_SUPER_ADMIN, 'This is the last active super admin — promote someone else first.');
  }
}

// Clean, complete permission map from a partial input (unknown keys rejected).
function permissionsFrom(input, base) {
  if (input === undefined) return base;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'permissions must be an object of flags');
  }
  const unknown = Object.keys(input).filter((k) => !PERMISSION_KEYS.includes(k));
  if (unknown.length) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `Unknown permission(s): ${unknown.join(', ')}`, {
      details: { fields: unknown.map((k) => ({ field: `permissions.${k}`, message: 'Unknown permission' })) },
    });
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(input)) out[k] = v === true;
  return out;
}

const storedPermissions = (admin) => Object.fromEntries(PERMISSION_KEYS.map((k) => [k, admin.permissions?.[k] === true]));

async function liveSessionCounts(adminIds) {
  const rows = await AdminSession.aggregate([
    { $match: { admin: { $in: adminIds }, revokedAt: null, expiresAt: { $gt: new Date() } } },
    { $group: { _id: '$admin', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

// @route GET /api/admin/admins?role=&active=&search=&page=&limit=
const listAdmins = asyncHandler(async (req, res) => {
  const filter = {};
  if (ROLE_VALUES.includes(req.query.role)) filter.role = req.query.role;
  if (req.query.active === 'true' || req.query.active === 'false') filter.isActive = req.query.active === 'true';
  if (typeof req.query.search === 'string' && req.query.search.trim()) {
    const escaped = req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [{ email: { $regex: escaped, $options: 'i' } }, { fullName: { $regex: escaped, $options: 'i' } }];
  }
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const [admins, total] = await Promise.all([
    Admin.find(filter).sort({ createdAt: 1 }).skip((page - 1) * limit).limit(limit),
    Admin.countDocuments(filter),
  ]);
  const counts = await liveSessionCounts(admins.map((a) => a._id));
  ok(
    res,
    admins.map((a) => presentAdmin(a, { liveSessions: counts.get(String(a._id)) || 0 })),
    { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
  );
});

// @route GET /api/admin/admins/:adminId
const getAdmin = asyncHandler(async (req, res) => {
  const admin = await Admin.findById(req.params.adminId);
  if (!admin) throw new AppError(ERROR_CODES.NOT_FOUND, 'Admin not found');
  const [counts, recentActions] = await Promise.all([
    liveSessionCounts([admin._id]),
    AdminAuditLog.find({ actor: admin._id }).sort({ createdAt: -1 }).limit(20).select('action module targetType targetId createdAt reason').lean(),
  ]);
  ok(res, {
    ...presentAdmin(admin, { liveSessions: counts.get(String(admin._id)) || 0 }),
    storedPermissions: storedPermissions(admin),
    recentActions,
  });
});

// @route POST /api/admin/admins   { email, fullName, role, permissions? }   (super admin)
const createAdmin = asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const fullName = String(req.body.fullName || '').trim();
  const role = req.body.role || 'admin';
  const problems = [];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) problems.push({ field: 'email', message: 'Enter a valid email address' });
  if (!fullName) problems.push({ field: 'fullName', message: 'Enter the admin’s name' });
  if (!ROLE_VALUES.includes(role)) problems.push({ field: 'role', message: `role must be one of ${ROLE_VALUES.join(', ')}` });
  if (problems.length) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, problems.map((p) => p.message).join('; '), { details: { fields: problems } });
  }
  if (await Admin.exists({ email })) throw new AppError(ERROR_CODES.CONFLICT, 'An admin with this email already exists');

  const permissions = permissionsFrom(req.body.permissions, { ...ROLE_PRESETS[role] });
  const password = temporaryPassword();
  const admin = new Admin({
    email,
    fullName,
    role,
    permissions,
    isActive: true,
    mustChangePassword: true,
    passwordChangedAt: new Date(),
    createdBy: req.user._id,
  });
  admin.password = password;
  await admin.save();

  await audit(req, {
    action: 'admin.create',
    module: 'admins',
    targetType: 'Admin',
    targetId: admin._id,
    after: { email, fullName, role, permissions },
  });
  // The temporary password is shown exactly once; only its hash is stored.
  created(res, { admin: presentAdmin(admin), temporaryPassword: password });
});

// @route PATCH /api/admin/admins/:adminId   { fullName?, isActive?, role?, permissions? }
const updateAdmin = asyncHandler(async (req, res) => {
  const admin = await loadTarget(req);
  const { fullName, isActive, role, permissions } = req.body;
  const changesAccess = role !== undefined || permissions !== undefined || isActive !== undefined;

  if (changesAccess && isSelf(req, admin)) {
    throw new AppError(ERROR_CODES.SELF_MODIFICATION, "You can't change your own role, permissions or active state");
  }
  if ((role !== undefined || permissions !== undefined) && !req.user.isSuperAdmin) {
    throw new AppError(ERROR_CODES.SUPER_ADMIN_REQUIRED, 'Only a super admin can change roles or permissions');
  }
  if (role !== undefined && !ROLE_VALUES.includes(role)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `role must be one of ${ROLE_VALUES.join(', ')}`, {
      details: { fields: [{ field: 'role', message: 'Unknown role' }] },
    });
  }
  if (isActive !== undefined && typeof isActive !== 'boolean') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'isActive must be true or false');
  }

  const losesSuperAdmin = admin.isSuperAdmin && ((role !== undefined && role !== 'super_admin') || isActive === false);
  if (losesSuperAdmin) await assertNotLastSuperAdmin(admin);

  const before = { fullName: admin.fullName, isActive: admin.isActive, role: admin.role, permissions: storedPermissions(admin) };
  if (typeof fullName === 'string' && fullName.trim()) admin.fullName = fullName.trim().slice(0, 100);
  if (isActive !== undefined) admin.isActive = isActive;
  if (role !== undefined && role !== admin.role) {
    admin.role = role;
    // A new role starts from that role's preset unless permissions are given.
    if (permissions === undefined) admin.permissions = { ...ROLE_PRESETS[role] };
  }
  if (permissions !== undefined) admin.permissions = permissionsFrom(permissions, storedPermissions(admin));
  await admin.save();
  const after = { fullName: admin.fullName, isActive: admin.isActive, role: admin.role, permissions: storedPermissions(admin) };

  // Losing access ends every session now rather than at token expiry.
  let signedOut = 0;
  if (before.isActive && !after.isActive) signedOut = await sessions.revokeAll(admin._id, 'deactivated');
  else if (before.role !== after.role) signedOut = await sessions.revokeAll(admin._id, 'role_changed');

  const changes = diff(before, after);
  await audit(req, {
    action: 'admin.update',
    module: 'admins',
    targetType: 'Admin',
    targetId: admin._id,
    before: changes.before,
    after: changes.after,
    reason: typeof req.body.reason === 'string' ? req.body.reason : '',
    meta: { sessionsSignedOut: signedOut },
  });
  ok(res, { admin: presentAdmin(admin), sessionsSignedOut: signedOut });
});

// @route POST /api/admin/admins/:adminId/reset-password
const resetPassword = asyncHandler(async (req, res) => {
  const admin = await loadTarget(req);
  if (isSelf(req, admin)) {
    throw new AppError(ERROR_CODES.SELF_MODIFICATION, 'Use change password for your own account');
  }
  const password = temporaryPassword();
  admin.password = password;
  admin.mustChangePassword = true;
  admin.passwordChangedAt = new Date();
  await admin.save();
  const signedOut = await sessions.revokeAll(admin._id, 'password_reset');
  await audit(req, {
    action: 'admin.password.reset',
    module: 'admins',
    targetType: 'Admin',
    targetId: admin._id,
    reason: typeof req.body.reason === 'string' ? req.body.reason : '',
    meta: { sessionsSignedOut: signedOut },
  });
  ok(res, { admin: presentAdmin(admin), temporaryPassword: password, sessionsSignedOut: signedOut });
});

// @route POST /api/admin/admins/:adminId/reset-2fa   (super admin — lost device)
const resetTwoFactor = asyncHandler(async (req, res) => {
  const admin = await loadTarget(req);
  if (isSelf(req, admin)) {
    throw new AppError(ERROR_CODES.SELF_MODIFICATION, 'Use your own two-factor settings for your account');
  }
  await Admin.updateOne(
    { _id: admin._id },
    {
      $set: { 'twoFactor.enabled': false, 'twoFactor.lastUsedCounter': 0 },
      $unset: { 'twoFactor.secretEnc': 1, 'twoFactor.recoveryCodeHashes': 1, 'twoFactor.pendingSecretEnc': 1, 'twoFactor.enrolledAt': 1 },
    }
  );
  const signedOut = await sessions.revokeAll(admin._id, 'two_factor_changed');
  await audit(req, {
    action: 'admin.2fa.reset',
    module: 'admins',
    targetType: 'Admin',
    targetId: admin._id,
    reason: typeof req.body.reason === 'string' ? req.body.reason : '',
  });
  ok(res, { twoFactorEnabled: false, sessionsSignedOut: signedOut });
});

// @route GET /api/admin/admins/:adminId/sessions
const listAdminSessions = asyncHandler(async (req, res) => {
  const admin = await Admin.findById(req.params.adminId);
  if (!admin) throw new AppError(ERROR_CODES.NOT_FOUND, 'Admin not found');
  const live = await AdminSession.find({ admin: admin._id, revokedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ lastUsedAt: -1 })
    .limit(50);
  ok(res, live.map((s) => s.toPublic(req.adminSession?._id)));
});

// @route DELETE /api/admin/admins/:adminId/sessions/:sessionId
const revokeAdminSession = asyncHandler(async (req, res) => {
  const admin = await loadTarget(req);
  const session = await AdminSession.findOne({ _id: req.params.sessionId, admin: admin._id });
  if (!session) throw new AppError(ERROR_CODES.NOT_FOUND, 'Session not found');
  await sessions.revoke(session, 'revoked_by_admin');
  await audit(req, {
    action: 'admin.session.revoke_other',
    module: 'admins',
    targetType: 'AdminSession',
    targetId: session._id,
    meta: { adminId: String(admin._id) },
  });
  ok(res, { revoked: true });
});

module.exports = {
  listAdmins,
  getAdmin,
  createAdmin,
  updateAdmin,
  resetPassword,
  resetTwoFactor,
  listAdminSessions,
  revokeAdminSession,
  // Defence in depth: through the API the acting super admin is itself an
  // active super admin and can't modify themselves, so this can't trip there —
  // it guards against future paths (scripts, bulk actions). Exported for tests.
  assertNotLastSuperAdmin,
};
