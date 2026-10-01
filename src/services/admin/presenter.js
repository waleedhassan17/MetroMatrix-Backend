/**
 * The admin as the console sees it. Permissions are the EFFECTIVE ones (a
 * super admin has every flag), so the app can gate UI on a single lookup —
 * and they are recomputed on every response, never trusted from a token.
 */
function presentAdmin(admin, extra = {}) {
  return {
    id: String(admin._id),
    email: admin.email,
    fullName: admin.fullName,
    role: admin.role,
    isSuperAdmin: !!admin.isSuperAdmin,
    permissions: admin.effectivePermissions(),
    avatar: admin.avatar || admin.profilePhoto || null,
    isActive: admin.isActive,
    mustChangePassword: !!admin.mustChangePassword,
    passwordChangedAt: admin.passwordChangedAt || null,
    twoFactorEnabled: !!admin.twoFactor?.enabled,
    lastLoginDate: admin.lastLoginDate || null,
    createdAt: admin.createdAt,
    ...extra,
  };
}

module.exports = { presentAdmin };
