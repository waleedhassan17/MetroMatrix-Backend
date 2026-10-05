const { pathOf } = require('../../utils/adminScope');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether this admin's sessions are limited to fixing their own account
 * before doing anything else:
 *   'password_change' — temporary/seeded password (mustChangePassword) or the
 *                       password is older than security.passwordExpiry days,
 *                       counted from the last RECORDED change. Accounts from
 *                       before changes were recorded start that clock at their
 *                       first sign-in (completeSignIn), not at createdAt;
 *   'totp_enrol'      — security.twoFactorEnabled requires super admins to use
 *                       two-factor sign-in and this one hasn't enrolled yet.
 * Computed on every request from the admin document and current settings, so
 * it lifts the moment the admin fixes it and applies the moment a super admin
 * turns a policy on.
 */
function sessionRestriction(admin, security, now = Date.now()) {
  if (admin.mustChangePassword) return 'password_change';
  if (security.passwordExpiry > 0) {
    // No createdAt fallback: an account older than the policy whose password
    // age was never recorded would otherwise be locked into a forced change
    // on its very first sign-in after the release.
    const changedAt = admin.passwordChangedAt;
    if (changedAt && now - new Date(changedAt).getTime() > security.passwordExpiry * DAY_MS) return 'password_change';
  }
  if (security.twoFactorEnabled && admin.isSuperAdmin && !admin.twoFactor?.enabled) return 'totp_enrol';
  return null;
}

// What a restricted session may still call: sign out, see who it is, manage
// its own sessions, and do the thing it is restricted for.
const ALWAYS_ALLOWED = [
  ['POST', /^\/api\/admin\/auth\/logout(-all)?$/],
  ['GET', /^\/api\/admin\/profile$/],
  ['GET', /^\/api\/admin\/meta$/],
  ['GET', /^\/api\/admin\/sessions$/],
  ['DELETE', /^\/api\/admin\/sessions\/[^/]+$/],
];
const ALLOWED_FOR = {
  password_change: [['PUT', /^\/api\/admin\/change-password$/]],
  totp_enrol: [
    ['POST', /^\/api\/admin\/auth\/2fa\/enrol$/],
    ['POST', /^\/api\/admin\/auth\/2fa\/verify$/],
  ],
};

function allowedWhileRestricted(req, restriction) {
  const path = pathOf(req).replace(/\/+$/, '');
  return [...ALWAYS_ALLOWED, ...(ALLOWED_FOR[restriction] || [])].some(
    ([method, re]) => req.method === method && re.test(path)
  );
}

module.exports = { sessionRestriction, allowedWhileRestricted };
