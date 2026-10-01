const AdminSettings = require('../models/AdminSettings');

/**
 * Short-lived cache of the AdminSettings singleton for per-request readers
 * (maintenance gate, session idle timeout, login lockout). Writers call
 * invalidate(); other serverless instances pick a change up within TTL_MS.
 */
const TTL_MS = 30 * 1000;

let cached = null;
let cachedAt = 0;

async function getAdminSettings({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < TTL_MS) return cached;
  const doc = await AdminSettings.getSettings();
  cached = doc.toObject();
  cachedAt = Date.now();
  return cached;
}

// Security settings with defaults filled in, so callers never see undefined.
async function getSecuritySettings(opts) {
  const s = (await getAdminSettings(opts)).security || {};
  return {
    twoFactorEnabled: s.twoFactorEnabled === true,
    sessionTimeout: Number.isFinite(s.sessionTimeout) ? s.sessionTimeout : 30,
    maxLoginAttempts: Number.isFinite(s.maxLoginAttempts) ? s.maxLoginAttempts : 5,
    lockoutMinutes: Number.isFinite(s.lockoutMinutes) ? s.lockoutMinutes : 15,
    passwordExpiry: Number.isFinite(s.passwordExpiry) ? s.passwordExpiry : 90,
  };
}

function invalidate() {
  cached = null;
  cachedAt = 0;
}

module.exports = { getAdminSettings, getSecuritySettings, invalidate, TTL_MS };
