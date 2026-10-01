/**
 * The admin-editable platform settings: every field, its type and its limits.
 *
 * One definition drives three things:
 *  - validation of PUT /api/admin/settings/:section (unknown keys are rejected,
 *    so a client still sending a removed setting finds out);
 *  - the `spec` returned by GET /api/admin/settings, from which the admin app
 *    renders its controls (no ranges or option lists hardcoded in the app);
 *  - the rule that only settings the backend actually ENFORCES are listed.
 *    Each entry names its consumer; a setting nothing reads does not belong
 *    here (see docs/ADMIN_SETTINGS.md for the ones removed and why).
 */
const PLATFORM_SETTINGS = Object.freeze({
  general: {
    label: 'General',
    permission: 'canManageSettings',
    fields: {
      platformName: { type: 'string', min: 1, max: 60, label: 'Platform name', usedBy: 'GET /api/admin/meta' },
      contactEmail: { type: 'email', allowEmpty: true, label: 'Admin contact email', usedBy: 'services/adminEmailService.js (fallback recipient)' },
      supportPhone: { type: 'string', max: 30, allowEmpty: true, label: 'Support phone', usedBy: 'GET /api/admin/meta' },
      maintenanceMode: { type: 'boolean', label: 'Maintenance mode', usedBy: 'middleware/maintenance.js' },
      maintenanceMessage: { type: 'string', max: 200, allowEmpty: true, label: 'Maintenance message', usedBy: 'middleware/maintenance.js' },
    },
  },
  notifications: {
    label: 'Notifications',
    permission: 'canManageSettings',
    fields: {
      emailNotifications: { type: 'boolean', label: 'Email the admin contact about new submissions', usedBy: 'services/adminEmailService.js' },
      providerRegistrations: { type: 'boolean', label: 'Notify on provider registration', usedBy: 'services/notificationService.js' },
      userRegistrations: { type: 'boolean', label: 'Notify on user registration', usedBy: 'services/notificationService.js' },
      systemAlerts: { type: 'boolean', label: 'System alerts', usedBy: 'services/notificationService.js' },
    },
  },
  security: {
    label: 'Security',
    superAdminOnly: true,
    fields: {
      twoFactorEnabled: { type: 'boolean', label: 'Require two-factor sign-in for super admins', usedBy: 'services/admin/sessionRestrictions.js' },
      sessionTimeout: { type: 'integer', min: 5, max: 1440, unit: 'minutes', label: 'Sign out after inactivity', usedBy: 'services/admin/sessionService.js' },
      maxLoginAttempts: { type: 'integer', min: 3, max: 20, label: 'Failed sign-ins before lockout', usedBy: 'controllers/admin/auth.js' },
      lockoutMinutes: { type: 'integer', min: 1, max: 1440, unit: 'minutes', label: 'Lockout duration', usedBy: 'controllers/admin/auth.js' },
      passwordExpiry: { type: 'integer', min: 0, max: 365, unit: 'days', label: 'Password expiry (0 = never)', usedBy: 'services/admin/sessionRestrictions.js' },
    },
  },
  finance: {
    label: 'Finance',
    superAdminOnly: true,
    fields: {
      adjustmentApprovalThreshold: {
        type: 'integer',
        min: 0,
        max: 10000000,
        unit: 'PKR',
        label: 'Wallet adjustments above this need a second super admin',
        usedBy: 'controllers/adminWalletController.js',
      },
    },
  },
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Validate a section update. Returns the clean partial update; throws a
 * { field, message }[] list (wrapped by the caller) on any problem.
 */
function validateSection(section, body) {
  const spec = PLATFORM_SETTINGS[section];
  const problems = [];
  const update = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { update, problems: [{ field: null, message: 'Body must be an object of settings' }] };
  }
  for (const [key, value] of Object.entries(body)) {
    const field = spec.fields[key];
    if (!field) {
      problems.push({ field: key, message: `Unknown ${section} setting '${key}'` });
      continue;
    }
    switch (field.type) {
      case 'boolean':
        if (typeof value !== 'boolean') problems.push({ field: key, message: `${field.label} must be true or false` });
        else update[key] = value;
        break;
      case 'integer':
        if (!Number.isInteger(value) || value < field.min || value > field.max) {
          problems.push({ field: key, message: `${field.label} must be a whole number from ${field.min} to ${field.max}` });
        } else update[key] = value;
        break;
      case 'email':
        if (typeof value !== 'string' || (value !== '' && !EMAIL.test(value)) || (value === '' && !field.allowEmpty)) {
          problems.push({ field: key, message: `${field.label} must be a valid email address` });
        } else update[key] = value.trim().toLowerCase();
        break;
      default: {
        const text = typeof value === 'string' ? value.trim() : null;
        const min = field.allowEmpty ? 0 : field.min || 0;
        if (text === null || text.length < min || (field.max && text.length > field.max)) {
          problems.push({ field: key, message: `${field.label} must be text of ${min}–${field.max} characters` });
        } else update[key] = text;
      }
    }
  }
  return { update, problems };
}

module.exports = { PLATFORM_SETTINGS, validateSection };
