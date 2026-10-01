const asyncHandler = require('express-async-handler');
const AdminSettings = require('../models/AdminSettings');
const AppError = require('../utils/AppError');
const { ERROR_CODES } = require('../utils/errorCodes');
const { ok } = require('../utils/apiResponse');
const { PLATFORM_SETTINGS, validateSection } = require('../config/platformSettings');
const { invalidate } = require('../services/settingsCache');
const { audit, diff } = require('../services/auditService');

// Values only — what each section currently holds.
const sectionValues = (settings, section) => {
  const stored = settings[section]?.toObject ? settings[section].toObject() : settings[section] || {};
  return Object.fromEntries(Object.keys(PLATFORM_SETTINGS[section].fields).map((k) => [k, stored[k]]));
};

// The spec the admin app renders controls from (types, limits, units, labels).
const publicSpec = () =>
  Object.fromEntries(
    Object.entries(PLATFORM_SETTINGS).map(([section, def]) => [
      section,
      {
        label: def.label,
        permission: def.permission || null,
        superAdminOnly: !!def.superAdminOnly,
        fields: Object.fromEntries(
          Object.entries(def.fields).map(([key, f]) => [
            key,
            { type: f.type, label: f.label, min: f.min, max: f.max, unit: f.unit, allowEmpty: f.allowEmpty },
          ])
        ),
      },
    ])
  );

// @desc    Platform settings + the spec to render them
// @route   GET /api/admin/settings
// @access  Admin
const getSettings = asyncHandler(async (req, res) => {
  const settings = await AdminSettings.getSettings();
  ok(res, {
    values: Object.fromEntries(Object.keys(PLATFORM_SETTINGS).map((s) => [s, sectionValues(settings, s)])),
    spec: publicSpec(),
    updatedAt: settings.updatedAt,
    lastUpdatedBy: settings.lastUpdatedBy || null,
  });
});

// @desc    Update one section
// @route   PUT /api/admin/settings/:section   (general | notifications | security)
// @access  general, notifications → canManageSettings; security → super admin
const updateSection = (section) =>
  asyncHandler(async (req, res) => {
    const { update, problems } = validateSection(section, req.body);
    if (problems.length) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, problems.map((p) => p.message).join('; '), {
        details: { fields: problems },
      });
    }
    if (!Object.keys(update).length) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Nothing to update', { details: { fields: [] } });
    }

    const before = sectionValues(await AdminSettings.getSettings(), section);
    const settings = await AdminSettings.updateSettings(section, update, req.user._id);
    invalidate();
    const after = sectionValues(settings, section);

    const changes = diff(before, after);
    await audit(req, {
      action: `settings.${section}.update`,
      module: 'settings',
      targetType: 'AdminSettings',
      targetId: settings._id,
      before: changes.before,
      after: changes.after,
      reason: typeof req.query.reason === 'string' ? req.query.reason : '',
    });

    ok(res, { section, values: after, updatedAt: settings.updatedAt });
  });

module.exports = {
  getSettings,
  updateGeneralSettings: updateSection('general'),
  updateNotificationSettings: updateSection('notifications'),
  updateSecuritySettings: updateSection('security'),
  updateFinanceSettings: updateSection('finance'),
};
