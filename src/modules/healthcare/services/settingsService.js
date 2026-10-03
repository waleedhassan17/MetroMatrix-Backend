const AdminSettings = require('../../../models/AdminSettings');

/**
 * Single source of truth for healthcare platform settings.
 * Values live in the AdminSettings singleton under `healthcare` and are the
 * SAME values payment, refund and booking code read — no duplicated constants.
 *
 * Only settings something reads are listed (all three feed paymentService).
 * defaultSlotDurationMinutes, maxAdvanceBookingDays and autoApproveDoctors
 * were editable but read by nothing, so changing them did nothing; removed.
 */
const HEALTHCARE_SETTINGS_DEFAULTS = Object.freeze({
  commissionPercent: 10,
  cancellationWindowHours: 12,
  lateCancelRefundPercent: 50,
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
