/**
 * Home-services platform settings — ONE source of truth.
 *
 * HS2 (matching weights), HS4 (commission, min payout) and HS5 (admin
 * settings screen) all read these values from here; the admin PATCH endpoint
 * writes them into the existing AdminSettings singleton under `homeservice`.
 */
const AdminSettings = require('../../../models/AdminSettings');
const { getOrSet, del } = require('../../../lib/cache');
const { k } = require('../../../lib/redis');

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
    // Completion-rate term. Weights are normalised by their sum at query time
    // (services/discoveryPipeline.js), so adding this one never inflates a score.
    quality: 0.15,
  },
  // "Online" counts only if the provider's app was seen this recently.
  onlineStaleMinutes: 30,
  // How the learned matching model is used (src/modules/ml/services/rankingService.js):
  // heuristic | shadow | blend | model. It only ever applies when a model is
  // active in ml_model_registry; otherwise search is the heuristic, whatever this says.
  ranking: { mode: 'heuristic', blendAlpha: 0.7, explorationBoost: 0.05 },
  minPayoutAmount: 500,
  // Average urban driving speed used for ETA estimates (Lahore traffic).
  avgUrbanSpeedKmh: 25,
};

const SETTINGS_CACHE_TTL_SEC = 60;
const settingsCacheKey = () => k('c', 'hs', 'settings');

async function loadSettingsStrict() {
  const doc = await AdminSettings.findOne().lean();
  const hs = doc && doc.homeservice ? doc.homeservice : {};
  return {
    ...DEFAULTS,
    ...hs,
    matchingWeights: { ...DEFAULTS.matchingWeights, ...(hs.matchingWeights || {}) },
    ranking: { ...DEFAULTS.ranking, ...(hs.ranking || {}) },
  };
}

/**
 * The current settings.
 *
 * Uncached by default — commission and payout minimums are read from here by
 * paymentService and earningsController, and money must never act on a stale
 * value. Hot read paths that only need ranking knobs (provider search) opt in
 * with `{ cached: true }`: a 60 s shared cache, invalidated on every admin
 * PATCH. A database error is never cached; it answers the defaults once.
 */
async function getHomeserviceSettings({ cached = false } = {}) {
  try {
    if (!cached) return await loadSettingsStrict();
    return await getOrSet(settingsCacheKey(), SETTINGS_CACHE_TTL_SEC, loadSettingsStrict);
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
    ranking: { ...DEFAULTS.ranking, ...(current.ranking || {}), ...(patch.ranking || {}) },
  };
  doc.markModified('homeservice');
  await doc.save();
  await del(settingsCacheKey());
  return doc.homeservice;
}

module.exports = { getHomeserviceSettings, updateHomeserviceSettings, DEFAULTS };
