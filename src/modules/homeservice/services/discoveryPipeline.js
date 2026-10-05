/**
 * Home-service discovery: the aggregation that finds and ranks providers.
 *
 * Pure builders — no database — so every branch is unit-tested
 * (__tests__/discovery.test.js). The controller only parses the request and
 * runs what these return.
 *
 * Ranking ("best match") — every term is in [0, 1], weights are admin-tunable
 * (AdminSettings.homeservice.matchingWeights) and the score is normalised by
 * their sum, so adding a weight never pushes a score past 1:
 *
 *   score = ( w_d·distance + w_r·rating + w_a·availableNow + w_q·quality ) / Σw
 *
 *   distance     1 − min(d / ring, 1) when the provider's base is pinned;
 *                shrunk halfway toward 0.5 when it is only their city's
 *                centroid; a neutral 0.5 when it is unknown or the customer
 *                gave no location. Unknown is never presented as near.
 *   rating       Bayesian average / 5: (C·m + avg·n) / (C + n) with prior
 *                m = 4.0 over C = 5 reviews, so one 5★ review cannot outrank
 *                two hundred 4.8★ ones.
 *   availableNow isAvailable ∧ isOnline ∧ seen within N minutes ∧ inside
 *                today's working hours (Pakistan time).
 *   quality      Laplace-smoothed completion rate (completed+1)/(total+2).
 */
const { LAHORE_CENTRE } = require('./geo');
const { DEFAULT_HOURS } = require('./catalogue');

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000; // Pakistan has no DST since 2009
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const HHMM_REGEX = '^([01][0-9]|2[0-3]):[0-5][0-9]$';
const RATING_PRIOR = { mean: 4.0, weight: 5 };
const KNOWN_SOURCES = ['profile', 'go_online', 'seed'];

/** Today's weekday key and 'HH:mm' in Pakistan time. */
function nowInPakistan(date = new Date()) {
  const wall = new Date(date.getTime() + PKT_OFFSET_MS);
  const hh = String(wall.getUTCHours()).padStart(2, '0');
  const mm = String(wall.getUTCMinutes()).padStart(2, '0');
  return { dayKey: WEEKDAYS[wall.getUTCDay()], hhmm: `${hh}:${mm}` };
}

/** Accepts today's and older clients' sort names. */
function normalizeSort(raw) {
  switch (String(raw || '').toLowerCase()) {
    case 'nearest':
    case 'distance':
      return 'nearest';
    case 'rating':
    case 'top_rated':
      return 'rating';
    case 'reviews':
      return 'reviews';
    case 'price_low':
    case 'price':
      return 'price_low';
    case 'price_high':
      return 'price_high';
    default:
      return 'best'; // '', 'best', 'default', 'match', 'experience', anything unknown
  }
}

function isPlaceholderExpr() {
  return {
    $and: [
      { $eq: [{ $arrayElemAt: ['$currentLocation.coordinates', 0] }, LAHORE_CENTRE[0]] },
      { $eq: [{ $arrayElemAt: ['$currentLocation.coordinates', 1] }, LAHORE_CENTRE[1]] },
    ],
  };
}

/**
 * The location source, tolerating documents written before the field
 * existed: a missing source on a non-placeholder point is a seeded base.
 */
function locationSourceExpr() {
  return { $ifNull: ['$locationSource', { $cond: [isPlaceholderExpr(), 'default', 'seed'] }] };
}

function hhmmOr(fieldPath, fallback) {
  return {
    $cond: [
      { $regexMatch: { input: { $toString: { $ifNull: [fieldPath, ''] } }, regex: HHMM_REGEX } },
      fieldPath,
      fallback,
    ],
  };
}

/** Inside today's working hours? Mirrors catalogue.hoursFor. */
function withinHoursExpr(dayKey, hhmm) {
  const d = `$availability.${dayKey}`;
  return {
    $cond: [
      { $eq: [`${d}.isAvailable`, false] },
      false,
      {
        $and: [
          { $gte: [hhmm, hhmmOr(`${d}.start`, DEFAULT_HOURS.start)] },
          { $lt: [hhmm, hhmmOr(`${d}.end`, DEFAULT_HOURS.end)] },
        ],
      },
    ],
  };
}

function availableNowExpr({ dayKey, hhmm, staleCutoff }) {
  return {
    $and: [
      { $ne: ['$isAvailable', false] },
      { $eq: ['$isOnline', true] },
      { $gte: [{ $ifNull: ['$lastSeen', new Date(0)] }, staleCutoff] },
      withinHoursExpr(dayKey, hhmm),
    ],
  };
}

function bayesRatingExpr() {
  const n = { $ifNull: ['$ratings.count', 0] };
  const avg = { $ifNull: ['$ratings.average', 0] };
  return {
    $divide: [
      { $add: [RATING_PRIOR.weight * RATING_PRIOR.mean, { $multiply: [avg, n] }] },
      { $add: [RATING_PRIOR.weight, n] },
    ],
  };
}

function qualityExpr() {
  const done = { $ifNull: ['$completedBookings', 0] };
  const total = { $max: [{ $ifNull: ['$totalBookings', 0] }, done] };
  return { $divide: [{ $add: [done, 1] }, { $add: [total, 2] }] };
}

function distanceTermExpr(hasLocation, radiusMeters) {
  if (!hasLocation) return 0.5;
  const closeness = { $subtract: [1, { $min: [{ $divide: ['$distanceMeters', radiusMeters] }, 1] }] };
  return {
    $switch: {
      branches: [
        { case: '$distanceKnown', then: closeness },
        { case: '$distanceApprox', then: { $add: [0.25, { $multiply: [0.5, closeness] }] } },
      ],
      default: 0.5,
    },
  };
}

function normalisedWeights(weights = {}) {
  const w = {
    distance: Math.max(0, Number(weights.distance) || 0),
    rating: Math.max(0, Number(weights.rating) || 0),
    availability: Math.max(0, Number(weights.availability) || 0),
    quality: Math.max(0, Number(weights.quality) || 0),
  };
  const sum = w.distance + w.rating + w.availability + w.quality;
  if (!sum) return { distance: 0.25, rating: 0.25, availability: 0.25, quality: 0.25 };
  return {
    distance: w.distance / sum,
    rating: w.rating / sum,
    availability: w.availability / sum,
    quality: w.quality / sum,
  };
}

function buildSort(sort, hasLocation) {
  switch (sort) {
    case 'nearest':
      // Nearest-first means nothing without knowing where "here" is.
      return hasLocation
        ? { distanceRank: 1, distanceMeters: 1, matchingScore: -1, _id: 1 }
        : { matchingScore: -1, bayesRating: -1, _id: 1 };
    case 'rating':
      return { bayesRating: -1, 'ratings.count': -1, matchingScore: -1, _id: 1 };
    case 'reviews':
      return { 'ratings.count': -1, bayesRating: -1, _id: 1 };
    case 'price_low':
      return { basePrice: 1, matchingScore: -1, _id: 1 };
    case 'price_high':
      return { basePrice: -1, matchingScore: -1, _id: 1 };
    default:
      return hasLocation
        ? { matchingScore: -1, distanceMeters: 1, _id: 1 }
        : { matchingScore: -1, bayesRating: -1, _id: 1 };
  }
}

/**
 * @param {object} o
 * @param {[number,number]|null} o.centre      customer [lng, lat], when known
 * @param {boolean} o.hasLocation
 * @param {number}  o.radiusMeters             search ring
 * @param {object}  o.match                    visibility/category/filters
 * @param {object}  o.weights                  matchingWeights
 * @param {string}  o.sort                     normalizeSort() value
 * @param {Date}    o.now
 * @param {number}  o.staleMinutes             presence freshness window
 * @param {boolean} o.availableOnly            filter to availableNow
 * @param {boolean} o.knownDistanceOnly        a "within X km" filter: unknown distances can't qualify
 * @param {number}  o.pageN, o.limitN
 */
function buildDiscoveryPipeline(o) {
  const now = o.now || new Date();
  const { dayKey, hhmm } = nowInPakistan(now);
  const staleCutoff = new Date(now.getTime() - (o.staleMinutes || 30) * 60 * 1000);
  const w = normalisedWeights(o.weights);
  const pipeline = [];

  if (o.hasLocation) {
    // $geoNear MUST be the first stage; spherical distances in metres.
    pipeline.push({
      $geoNear: {
        near: { type: 'Point', coordinates: o.centre },
        distanceField: 'distanceMeters',
        maxDistance: o.radiusMeters,
        spherical: true,
        query: o.match,
      },
    });
  } else {
    // No "near you" without a "you": search everywhere, not 40 km around Lahore.
    pipeline.push({ $match: o.match });
  }

  pipeline.push({ $addFields: { _locSrc: locationSourceExpr() } });
  pipeline.push({
    $addFields: {
      distanceKnown: { $in: ['$_locSrc', KNOWN_SOURCES] },
      distanceApprox: { $eq: ['$_locSrc', 'city'] },
    },
  });

  if (o.hasLocation) {
    // Each provider's own reach: someone who serves 10 km is not offered to a
    // customer 20 km away. Only enforceable where their base is actually known.
    pipeline.push({
      $match: {
        $expr: {
          $or: [
            { $not: ['$distanceKnown'] },
            { $lte: ['$distanceMeters', { $multiply: [{ $ifNull: ['$serviceRadius', 15] }, 1000] }] },
          ],
        },
      },
    });
    if (o.knownDistanceOnly) pipeline.push({ $match: { distanceKnown: true } });
  }

  pipeline.push({
    $addFields: {
      availableNow: availableNowExpr({ dayKey, hhmm, staleCutoff }),
      bayesRating: bayesRatingExpr(),
      quality: qualityExpr(),
      distanceRank: { $cond: ['$distanceKnown', 0, { $cond: ['$distanceApprox', 1, 2] }] },
    },
  });
  pipeline.push({
    $addFields: {
      scoreBreakdown: {
        distance: distanceTermExpr(o.hasLocation, o.radiusMeters),
        rating: { $divide: ['$bayesRating', 5] },
        availability: { $cond: ['$availableNow', 1, 0] },
        quality: '$quality',
      },
    },
  });
  pipeline.push({
    $addFields: {
      matchingScore: {
        $add: [
          { $multiply: [w.distance, '$scoreBreakdown.distance'] },
          { $multiply: [w.rating, '$scoreBreakdown.rating'] },
          { $multiply: [w.availability, '$scoreBreakdown.availability'] },
          { $multiply: [w.quality, '$scoreBreakdown.quality'] },
        ],
      },
    },
  });

  if (o.availableOnly) pipeline.push({ $match: { availableNow: true } });

  pipeline.push(
    { $sort: buildSort(o.sort, o.hasLocation) },
    {
      $facet: {
        items: [{ $skip: (o.pageN - 1) * o.limitN }, { $limit: o.limitN }],
        total: [{ $count: 'count' }],
      },
    }
  );
  return pipeline;
}

module.exports = {
  buildDiscoveryPipeline,
  buildSort,
  normalizeSort,
  normalisedWeights,
  nowInPakistan,
  availableNowExpr,
  withinHoursExpr,
  RATING_PRIOR,
  KNOWN_SOURCES,
};
