const asyncHandler = require('express-async-handler');
const { understandService, LABELS } = require('../services/serviceIntent');
const { discoverProviders } = require('../services/recsService');

function origin(q) {
  const lat = Number(q.lat);
  const lng = Number(q.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
}

/**
 * GET /api/search/services?q=&lat=&lng=
 *
 * Which trade the problem needs, plus the top three providers for it (the
 * discovery ranking, near the given point when there is one). The app then
 * opens the full provider list with the same category and filter.
 */
const searchServices = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) {
    res.status(400);
    throw new Error('Describe the problem in a few words');
  }
  const { interpreted, source } = await understandService(q);
  const label = (c) => ({ category: c, label: LABELS[c] });
  let providers = [];
  let noneAvailableNow = false;
  if (interpreted.category) {
    const at = origin(req.query);
    providers = await discoverProviders(interpreted.category, at, { availableOnly: interpreted.availableNow, limit: 3 });
    if (!providers.length && interpreted.availableNow) {
      // Nobody online right now: say so, and still show who could come later.
      noneAvailableNow = true;
      providers = await discoverProviders(interpreted.category, at, { limit: 3 });
    }
  }
  res.json({
    success: true,
    data: {
      query: q,
      interpreted: {
        ...(interpreted.category ? label(interpreted.category) : { category: null, label: null }),
        availableNow: interpreted.availableNow,
        candidates: interpreted.candidates.map(label),
        source,
      },
      providers,
      noneAvailableNow,
    },
  });
});

module.exports = { searchServices };
