/**
 * 01 — admin auth & settings cleanup (phase B1).
 *
 * - Unsets Admin.refreshToken (replaced by AdminSession; existing admin
 *   sessions end and admins sign in once more).
 * - Unsets the settings that were stored and editable but enforced by
 *   nothing (see docs/ADMIN_SETTINGS.md).
 * - Builds the indexes of the new collections (AdminSession, LoginAttempt,
 *   AdminAuditLog). Production runs with autoIndex off, so without this the
 *   TTL clean-up and the LoginAttempt unique key would not exist.
 *
 * Rollback: nothing to restore — the removed fields were never read. To go
 * back to the previous release, re-deploy it; admins sign in again.
 */
const { runMigration } = require('./lib');
const Admin = require('../../src/models/Admin');
const AdminSettings = require('../../src/models/AdminSettings');
const AdminSession = require('../../src/models/AdminSession');
const LoginAttempt = require('../../src/models/LoginAttempt');
const AdminAuditLog = require('../../src/models/AdminAuditLog');

const REMOVED_SETTINGS = [
  'general.timezone',
  'general.language',
  'general.autoApproveProviders',
  'general.requireEmailVerification',
  'notifications.pushNotifications',
  'notifications.weeklyReports',
  'security.ipWhitelist',
  'appearance',
  'healthcare.defaultSlotDurationMinutes',
  'healthcare.maxAdvanceBookingDays',
  'healthcare.autoApproveDoctors',
  'homeservice.cancellationWindowHours',
];

runMigration('01-admin-auth-cleanup', async ({ dry, log }) => {
  const admins = Admin.collection;
  const withToken = await admins.countDocuments({ refreshToken: { $exists: true } });
  log(`admins with a stored refreshToken: ${withToken}`);

  const settingsColl = AdminSettings.collection;
  const settingsWithRemoved = await settingsColl.countDocuments({
    $or: REMOVED_SETTINGS.map((p) => ({ [p]: { $exists: true } })),
  });
  log(`settings documents holding removed fields: ${settingsWithRemoved}`);

  if (dry) return { withToken, settingsWithRemoved, indexesBuilt: false };

  await admins.updateMany({ refreshToken: { $exists: true } }, { $unset: { refreshToken: '' } });
  await settingsColl.updateMany({}, { $unset: Object.fromEntries(REMOVED_SETTINGS.map((p) => [p, ''])) });
  for (const model of [AdminSession, LoginAttempt, AdminAuditLog]) {
    await model.createIndexes();
    log(`indexes ensured: ${model.collection.collectionName}`);
  }
  return { withToken, settingsWithRemoved, indexesBuilt: true };
}).catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
