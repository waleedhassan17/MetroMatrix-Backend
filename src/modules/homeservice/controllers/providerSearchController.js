const asyncHandler = require('express-async-handler');
const Provider = require('../../../models/Provider');
const Booking = require('../models/Booking');
const ProviderReview = require('../models/ProviderReview');
const { getHomeserviceSettings } = require('../services/settingsService');
const { estimatedTravelMinutes } = require('../services/matchingService');
const mongoose = require('mongoose');
const {
  toPublicProviderCard,
  publicName,
  CATEGORY_TO_SUBTYPE,
  avatar,
  coords,
} = require('../services/serializers');
const { searchableProviderFilter } = require('../services/providerVisibility');
const { servicesFor, weeklyAvailability } = require('../services/catalogue');
const { buildDiscoveryPipeline, normalizeSort } = require('../services/discoveryPipeline');
const { LAHORE_CENTRE } = require('../services/geo');
const { SEARCH_NS } = require('../services/discoveryConstants');
const { getOrSet, ns, hashOf } = require('../../../lib/cache');
const { k } = require('../../../lib/redis');
const crypto = require('crypto');
const MlSearchImpression = require('../../ml/models/MlSearchImpression');
const { getModelNonBlocking } = require('../../ml/services/modelStore');
const { rerank, withFeatures } = require('../../ml/services/rankingService');

const ok = (res, data, message, pagination) =>
  res.json({ success: true, data, message, ...(pagination ? { pagination } : {}) });

const HS_CATEGORIES = Object.keys(CATEGORY_TO_SUBTYPE); // electricians | plumbers | ac-repairers

/**
 * GET /api/providers — home-service discovery with $geoNear + weighted score.
 *
 * Falls through (next()) to the legacy provider listing when the request names
 * NO category at all — that is a different endpoint's job.
 *
 * A request that DOES name a category but names one we cannot map is a
 * different situation entirely, and must not fall through. It used to: an
 * unrecognised slug reached the legacy listing, which applies no subtype
 * filter, so the caller got every provider in the system back and the screen
 * rendered them under whatever category had been tapped. That is what made
 * every category look like it was full of electricians — a seeded
 * 'appliance-technicians' category was missing from CATEGORY_TO_SUBTYPE.
 *
 * An unknown category now returns an empty page. Silence is the correct answer
 * to "show me providers of a trade that does not exist"; showing everyone is
 * not.
 */
const searchProviders = asyncHandler(async (req, res, next) => {
  const {
    category,
    serviceCategory,
    lat,
    lng,
    radiusKm,
    maxDistanceKm,
    minRating,
    maxPrice,
    verified,
    available,
    search,
    sortBy,
    sort,
    filters,
    page = 1,
    limit = 15,
  } = req.query;

  const cat = category || serviceCategory;
  if (!cat) {
    return next(); // not a home-service search — legacy /api/providers handles it
  }
  if (!HS_CATEGORIES.includes(cat)) {
    // Same envelope as the success path below, so the client's list, pagination
    // and empty state all behave normally rather than meeting a shape they do
    // not parse.
    return ok(
      res,
      {
        providers: [],
        pagination: {
          currentPage: 1,
          totalPages: 1,
          totalItems: 0,
          itemsPerPage: parseInt(limit, 10) || 15,
          hasNext: false,
          hasPrevious: false,
        },
      },
      `Unknown service category "${cat}"`
    );
  }

  // fetchProviders() JSON-stringifies its filters object
  let parsedFilters = {};
  if (filters) {
    try {
      parsedFilters = JSON.parse(filters);
    } catch (e) {
      parsedFilters = {};
    }
  }
  const fMinRating = Number(minRating || parsedFilters.minRating || 0);
  const fMaxPrice = Number(maxPrice || parsedFilters.maxPrice || 0);
  // `verified` is accepted for older clients but needs no clause: every
  // provider a customer can see has already been approved.
  // `available` means available NOW — online, recently seen, inside working
  // hours — not the `isAvailable` flag, which defaults to true and so used to
  // filter out nobody.
  const fAvailable = available === 'true' || parsedFilters.available === true;
  const fMaxDistanceKm = Number(maxDistanceKm || parsedFilters.maxDistanceKm || parsedFilters.radiusKm || 0);

  // Ranking knobs only — the shared 60 s cache is safe here (never for money).
  const settings = await getHomeserviceSettings({ cached: true });

  // The customer's position, when the app knows it (their saved address, or
  // the phone's). Without one there is no "near you" to speak of: the search
  // covers every city and no distance is reported, rather than measuring
  // every provider from the city centre and presenting that as "2.1 km away".
  const latN = Number(lat);
  const lngN = Number(lng);
  const hasLocation =
    lat !== undefined &&
    lng !== undefined &&
    Number.isFinite(latN) &&
    Number.isFinite(lngN) &&
    Math.abs(latN) <= 90 &&
    Math.abs(lngN) <= 180 &&
    !(latN === 0 && lngN === 0) &&
    // The old saved-address placeholder is not a customer location.
    !(lngN === LAHORE_CENTRE[0] && latN === LAHORE_CENTRE[1]);
  const centre = hasLocation ? [lngN, latN] : null;

  const match = searchableProviderFilter(CATEGORY_TO_SUBTYPE[cat]);
  if (fMinRating) match['ratings.average'] = { $gte: fMinRating };
  if (fMaxPrice) match.basePrice = { $lte: fMaxPrice };
  const term = typeof search === 'string' ? search.trim().slice(0, 60) : '';
  if (term) {
    // Escaped: this is a customer's typing, not a pattern. "(" or "*" used to
    // reach MongoDB as regex syntax and fail the whole request with a 500.
    const pattern = escapeRegex(term);
    match.$or = [
      { fullName: { $regex: pattern, $options: 'i' } },
      { profession: { $regex: pattern, $options: 'i' } },
      { briefDescription: { $regex: pattern, $options: 'i' } },
    ];
  }

  const pageN = Math.max(parseInt(page, 10) || 1, 1);
  const limitN = Math.min(Math.max(parseInt(limit, 10) || 15, 1), 50);
  const sortKey = normalizeSort(sortBy || sort);

  // Nearby first. Only if nobody serves the customer within the configured
  // radius does the search reach further — a list is never empty merely
  // because the ring was drawn too tight, and never padded with far-away
  // providers when close ones exist. An explicit "within X km" filter is a
  // promise: no widening, and unknown distances cannot qualify.
  const baseKm = Number(radiusKm) > 0 ? Number(radiusKm) : settings.defaultSearchRadiusKm;
  let rings = [null];
  if (hasLocation) {
    rings = fMaxDistanceKm > 0
      ? [Math.min(fMaxDistanceKm, 100)]
      : [baseKm, ...WIDER_RINGS_KM.filter((r) => r > baseKm)];
  }

  const now = new Date();
  const runSearchWith = async ({ pageN: pN, limitN: lN }) => {
    let result = { items: [], total: [] };
    let usedKm = rings[0];
    for (const km of rings) {
      usedKm = km;
      [result] = await Provider.aggregate(
        buildDiscoveryPipeline({
          centre,
          hasLocation,
          radiusMeters: (km || 0) * 1000,
          match,
          weights: settings.matchingWeights,
          sort: sortKey,
          now,
          staleMinutes: settings.onlineStaleMinutes,
          availableOnly: fAvailable,
          knownDistanceOnly: fMaxDistanceKm > 0,
          pageN: pN,
          limitN: lN,
        })
      );
      if (result.total[0] && result.total[0].count) break;
    }
    return { items: result.items || [], total: (result.total[0] && result.total[0].count) || 0, usedKm };
  };
  const runSearch = () => runSearchWith({ pageN, limitN });

  // Shared 30 s cache keyed by everything that shapes the answer; customers
  // are bucketed to ~1 km (2 dp), and the namespace is bumped whenever a
  // provider's availability or base changes.
  const cacheKey = k(
    'c', 'hs', 'search', `v${await ns(SEARCH_NS)}`, cat,
    hasLocation ? `${latN.toFixed(2)},${lngN.toFixed(2)}` : 'anywhere',
    hashOf({ sortKey, fMinRating, fMaxPrice, fAvailable, fMaxDistanceKm, term, baseKm, pageN, limitN })
  );
  // Stage 2 — the learned model, when one is active and the admin turned it
  // on. Only "best match" is re-ranked (an explicit sort is the customer's
  // choice). The top RERANK_POOL candidates are re-ordered and then paged;
  // past the pool the heuristic order continues.
  const ranking = settings.ranking || { mode: 'heuristic' };
  const servedModel = ranking.mode !== 'heuristic' && sortKey === 'best' ? getModelNonBlocking() : null;
  const pool = Math.min(RERANK_POOL, Math.max(pageN * limitN, limitN));
  const reranking = Boolean(servedModel) && pageN * limitN <= RERANK_POOL;

  let items;
  let total;
  let usedKm;
  let rankingSource = 'heuristic';
  let scored = null;
  if (reranking) {
    const poolKey = `${cacheKey}:pool${pool}`;
    const poolPage = { pageN: 1, limitN: pool };
    const stage1 = await getOrSet(poolKey, SEARCH_CACHE_SEC, () => runSearchWith(poolPage));
    const ranked = await rerank(stage1.items, { ...ranking, model: servedModel, hasLocation });
    const start = (pageN - 1) * limitN;
    items = ranked.items.slice(start, start + limitN);
    scored = ranked.scored.slice(start, start + limitN);
    total = stage1.total;
    usedKm = stage1.usedKm;
    rankingSource = ranked.rankingSource;
  } else {
    ({ items, total, usedKm } = await getOrSet(cacheKey, SEARCH_CACHE_SEC, runSearch));
  }
  const totalPages = Math.max(1, Math.ceil(total / limitN));

  // What this search showed, with each card's serve-time features — the
  // matching model's training data. Capped at 250 ms: a slow write must never
  // slow a search, and a lost impression only costs a little signal.
  const searchId = crypto.randomUUID();
  if (Math.random() < IMPRESSION_SAMPLE && items.length) {
    const features = scored || withFeatures(items, hasLocation).map((r) => ({ features: r.features, heuristicScore: r.p.matchingScore, modelScore: null }));
    await Promise.race([
      MlSearchImpression.create({
        searchId,
        userId: req.user ? req.user._id : null,
        category: cat,
        hasLocation,
        sort: sortKey,
        rankingSource,
        items: items.map((p, i) => ({
          providerId: p._id,
          position: (pageN - 1) * limitN + i,
          heuristicScore: features[i] ? features[i].heuristicScore : p.matchingScore,
          modelScore: features[i] ? features[i].modelScore : null,
          features: features[i] ? features[i].features : undefined,
        })),
      }).catch((e) => console.warn(`[ml] impression not logged: ${e.message}`)),
      new Promise((resolve) => setTimeout(resolve, 250)),
    ]);
  }

  ok(res, {
    providers: items.map((p) => toDiscoveryCard(p, { hasLocation, avgSpeed: settings.avgUrbanSpeedKmh, rankingSource })),
    pagination: {
      currentPage: pageN,
      totalPages,
      totalItems: total,
      itemsPerPage: limitN,
      hasNext: pageN < totalPages,
      hasPrevious: pageN > 1,
    },
    searchArea: {
      nearYou: hasLocation,
      radiusKm: hasLocation ? usedKm : null,
      widened: hasLocation && !(fMaxDistanceKm > 0) && usedKm > baseKm,
    },
    sort: sortKey,
    rankingSource,
    // Pass back on booking (rankingContext) so the outcome can be credited to
    // the search that produced it.
    searchId,
  }, 'Providers fetched successfully');
});

/** One search result as a public card, plus what ranking knows about it. */
function toDiscoveryCard(p, { hasLocation, avgSpeed, rankingSource = 'heuristic' }) {
  const located = p.distanceKnown || p.distanceApprox;
  const showDistance = hasLocation && located && Number.isFinite(p.distanceMeters);
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  return toPublicProviderCard(p, {
    distanceKm: showDistance ? Math.round((p.distanceMeters / 1000) * 10) / 10 : null,
    distanceApprox: Boolean(showDistance && p.distanceApprox),
    etaMinutes: showDistance && p.distanceKnown ? estimatedTravelMinutes(p.distanceMeters, avgSpeed) : null,
    availableNow: Boolean(p.availableNow),
    matchingScore: Math.round((p.matchingScore || 0) * 1000) / 1000,
    scoreBreakdown: p.scoreBreakdown
      ? {
          distance: round2(p.scoreBreakdown.distance),
          rating: round2(p.scoreBreakdown.rating),
          availability: round2(p.scoreBreakdown.availability),
          quality: round2(p.scoreBreakdown.quality),
        }
      : null,
    // A base is an area (~500 m grid), and only shown when one is set.
    coordinates: located ? coords(p.currentLocation) : null,
    rankingSource,
    ...(typeof p.modelScore === 'number' ? { modelScore: p.modelScore } : {}),
  });
}

/** How long one search answer is shared between customers in the same ~1 km cell. */
const SEARCH_CACHE_SEC = 30;
/** How many top candidates the learned model may re-order. */
const RERANK_POOL = 50;
/** Share of searches whose impressions are logged for training (0..1). */
const IMPRESSION_SAMPLE = Math.min(Math.max(Number(process.env.ML_IMPRESSION_SAMPLE ?? 1), 0), 1);
/** Rings tried, in order, after the configured radius finds no one. */
const WIDER_RINGS_KM = [30, 60];

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Kept for callers/tests that build the pipeline directly. */
function buildPipeline({ centre, radiusMeters, match, weights, hasLocation, sortBy, pageN, limitN, now, staleMinutes }) {
  return buildDiscoveryPipeline({
    centre,
    hasLocation,
    radiusMeters,
    match,
    weights,
    sort: normalizeSort(sortBy),
    now,
    staleMinutes,
    pageN,
    limitN,
  });
}

/**
 * GET /api/providers/:providerId — home-service profile (ProviderDetails).
 * Falls through to the legacy handler for non-home-service providers.
 */
const getProviderDetails = asyncHandler(async (req, res, next) => {
  const { providerId } = req.params;
  if (!/^[a-f0-9]{24}$/i.test(providerId)) return next();
  const p = await Provider.findById(providerId);
  if (!p || p.providerType !== 'home_service') return next();

  const [reviews, completedJobs] = await Promise.all([
    ProviderReview.find({ provider: p._id })
      .populate('customer', 'fullName profilePhoto')
      .sort({ createdAt: -1 })
      .limit(10),
    Booking.countDocuments({ provider: p._id, status: 'COMPLETED' }),
  ]);

  const AVATAR_COLORS = ['#4F46E5', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6'];

  ok(res, {
    ...toPublicProviderCard(p),
    completedJobs,
    servicesOffered: servicesFor(p),
    availability: weeklyAvailability(p),
    gallery: [],
    reviewsList: reviews.map((r, i) => ({
      id: String(r._id),
      reviewerName: publicName(r.customer && r.customer.fullName),
      reviewerInitial: r.customer && r.customer.fullName ? r.customer.fullName[0].toUpperCase() : 'C',
      rating: r.rating,
      comment: r.comment || '',
      date: r.createdAt.toISOString().slice(0, 10),
      helpfulCount: 0,
      avatarColor: AVATAR_COLORS[i % AVATAR_COLORS.length],
      tags: r.tags || [],
    })),
  }, 'Provider details fetched');
});

// GET /api/providers/:providerId/reviews — paginated, newest first
const getProviderReviews = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.providerId)) {
    res.status(404);
    throw new Error('Provider not found');
  }
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 50);
  const [reviews, total] = await Promise.all([
    ProviderReview.find({ provider: req.params.providerId })
      .populate('customer', 'fullName profilePhoto')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    ProviderReview.countDocuments({ provider: req.params.providerId }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  ok(res, reviews.map((r) => ({
    id: String(r._id),
    rating: r.rating,
    comment: r.comment || '',
    customerName: publicName(r.customer && r.customer.fullName),
    customerAvatar: avatar(publicName(r.customer && r.customer.fullName), r.customer && r.customer.profilePhoto),
    createdAt: r.createdAt.toISOString(),
  })), 'Reviews fetched', {
    currentPage: page,
    totalPages,
    totalItems: total,
    itemsPerPage: limit,
    hasNext: page < totalPages,
    hasPrevious: page > 1,
  });
});

module.exports = {
  searchProviders,
  getProviderDetails,
  getProviderReviews,
  escapeRegex,
  buildPipeline,
  toDiscoveryCard,
  SEARCH_NS,
};
