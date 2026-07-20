/**
 * Home-services platform settings — ONE source of truth.
 *
 * HS2 (matching weights), HS4 (commission, min payout) and HS5 (admin
 * settings screen) all read these values from here; the admin PATCH endpoint
 * writes them into the existing AdminSettings singleton under `homeservice`.
 */
const AdminSettings = require('../../../models/AdminSettings');

// Defaults — hardcoded for FYP-I; matching weights are intended to be
// learned from booking outcomes in FYP-II.
const DEFAULTS = {
  commissionPercent: 10,
  cancellationWindowHours: 2,
  defaultSearchRadiusKm: 15,
  matchingWeights: {
    distance: 0.4,
    rating: 0.4,
    availability: 0.2,
  },
  minPayoutAmount: 500,
  // Average urban driving speed used for ETA estimates (Lahore traffic).
  avgUrbanSpeedKmh: 25,
};

async function getHomeserviceSettings() {
  try {
    const doc = await AdminSettings.findOne().lean();
    const hs = doc && doc.homeservice ? doc.homeservice : {};
    return {
      ...DEFAULTS,
      ...hs,
      matchingWeights: { ...DEFAULTS.matchingWeights, ...(hs.matchingWeights || {}) },
    };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

async function updateHomeserviceSettings(patch) {
  let doc = await AdminSettings.findOne();
  if (!doc) {
    doc = new AdminSettings({});
  }
  const current = doc.homeservice || {};
  doc.homeservice = {
    ...DEFAULTS,
    ...current,
    ...patch,
    matchingWeights: {
      ...DEFAULTS.matchingWeights,
      ...(current.matchingWeights || {}),
      ...(patch.matchingWeights || {}),
    },
  };
  doc.markModified('homeservice');
  await doc.save();
  return doc.homeservice;
}

module.exports = { getHomeserviceSettings, updateHomeserviceSettings, DEFAULTS };
