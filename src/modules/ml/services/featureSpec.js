/**
 * Provider-matching features — THE CONTRACT with ml/mm_ml/matching.py FEATURES.
 * Same names, same order, same definitions. Computed here at serve time from a
 * search result, logged with the impression, and that is what the model trains
 * on. Change one side and the parity check refuses the model.
 */
const FEATURES = [
  'distance_term',
  'distance_known',
  'distance_km',
  'rating_term',
  'reviews_log',
  'available_now',
  'quality',
  'price_ratio',
  'is_new',
  'online',
];

const LOG_500 = Math.log1p(500);

function median(values) {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * @param {object} p      a discovery-pipeline result row (Provider + scoreBreakdown, distanceKnown…)
 * @param {object} ctx    { hasLocation, medianPrice }
 * @returns {Record<string, number>}
 */
function rawFeatures(p, ctx) {
  const b = p.scoreBreakdown || {};
  const known = Boolean(ctx.hasLocation && p.distanceKnown && Number.isFinite(p.distanceMeters));
  const km = known ? p.distanceMeters / 1000 : null;
  const count = (p.ratings && p.ratings.count) || 0;
  const price = Number(p.basePrice) || 0;
  const ratio = ctx.medianPrice > 0 && price > 0 ? Math.min(Math.max(price / ctx.medianPrice, 0), 3) / 3 : 1 / 3;
  return {
    distance_term: num(b.distance, 0.5),
    distance_known: known ? 1 : 0,
    distance_km: known ? Math.min(km, 30) / 30 : 0.5,
    rating_term: num(b.rating, 0),
    reviews_log: Math.min(Math.log1p(count) / LOG_500, 1),
    available_now: p.availableNow ? 1 : 0,
    quality: num(b.quality, 0.5),
    price_ratio: ratio,
    is_new: (p.completedBookings || 0) < 3 ? 1 : 0,
    online: p.isOnline ? 1 : 0,
  };
}

function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Ordered vector for the model, standardised with the model's own mean/std. */
function toVector(features, spec) {
  const names = spec.names || FEATURES;
  return names.map((name, i) => {
    const raw = typeof features[name] === 'number' ? features[name] : 0;
    const std = spec.std && spec.std[i] ? spec.std[i] : 1;
    const mean = spec.mean ? spec.mean[i] || 0 : 0;
    return (raw - mean) / std;
  });
}

module.exports = { FEATURES, rawFeatures, toVector, median };
