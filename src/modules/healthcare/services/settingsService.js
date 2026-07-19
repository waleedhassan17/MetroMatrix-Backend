const AdminSettings = require('../../../models/AdminSettings');

/**
 * Single source of truth for healthcare platform settings.
 * Values live in the AdminSettings singleton under `healthcare` and are the
 * SAME values payment, refund and booking code read — no duplicated constants.
 */
const HEALTHCARE_SETTINGS_DEFAULTS = Object.freeze({
  commissionPercent: 10,
  cancellationWindowHours: 12,
  lateCancelRefundPercent: 50,
  defaultSlotDurationMinutes: 30,
  maxAdvanceBookingDays: 30,
  autoApproveDoctors: false,
});

const getHealthcareSettings = async () => {
  const settings = await AdminSettings.getSettings();
  const stored = settings.healthcare ? settings.healthcare.toObject() : {};
  return { ...HEALTHCARE_SETTINGS_DEFAULTS, ...stored };
};

const updateHealthcareSettings = async (patch, adminId) => {
  const settings = await AdminSettings.getSettings();
  const current = settings.healthcare ? settings.healthcare.toObject() : {};
  const allowed = {};
  Object.keys(HEALTHCARE_SETTINGS_DEFAULTS).forEach((key) => {
    if (patch[key] !== undefined) allowed[key] = patch[key];
  });
  settings.healthcare = { ...current, ...allowed };
  settings.lastUpdatedBy = adminId;
  await settings.save();
  return { ...HEALTHCARE_SETTINGS_DEFAULTS, ...settings.healthcare.toObject() };
};

module.exports = {
  HEALTHCARE_SETTINGS_DEFAULTS,
  getHealthcareSettings,
  updateHealthcareSettings,
};
