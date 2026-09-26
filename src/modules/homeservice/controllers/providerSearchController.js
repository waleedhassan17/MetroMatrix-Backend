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
} = require('../services/serializers');
const { searchableProviderFilter } = require('../services/providerVisibility');
const { servicesFor, weeklyAvailability } = require('../services/catalogue');

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
  const fAvailable = available === 'true' || parsedFilters.available === true;

  const settings = await getHomeserviceSettings();
  const weights = settings.matchingWeights;

  // The customer's position, when the app knows it (their saved address, or
  // the phone's). Without one there is no "near you" to speak of: the search
  // covers the whole city and no distance is reported, rather than measuring
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
    !(latN === 0 && lngN === 0);
  const centre = hasLocation ? [lngN, latN] : LAHORE_CENTRE;

  const match = searchableProviderFilter(CATEGORY_TO_SUBTYPE[cat]);
  if (fMinRating) match['ratings.average'] = { $gte: fMinRating };
  if (fMaxPrice) match.basePrice = { $lte: fMaxPrice };
  if (fAvailable) match.isAvailable = true;
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

  // Nearby first. Only if nobody serves the customer within the configured
  // radius does the search reach further — a list is never empty merely
  // because the ring was drawn too tight, and never padded with far-away
  // providers when close ones exist.
  const baseKm = Number(radiusKm) > 0 ? Number(radiusKm) : settings.defaultSearchRadiusKm;
  const rings = hasLocation
    ? [baseKm, ...WIDER_RINGS_KM.filter((r) => r > baseKm)]
    : [CITY_RADIUS_KM];

  let result = { items: [], total: [] };
  let radiusMeters = rings[0] * 1000;
  for (const km of rings) {
    radiusMeters = km * 1000;
    [result] = await Provider.aggregate(
      buildPipeline({ centre, radiusMeters, match, weights, hasLocation, sortBy: sortBy || sort, pageN, limitN })
    );
    if (result.total[0] && result.total[0].count) break;
  }

  const items = result.items || [];
  const total = (result.total[0] && result.total[0].count) || 0;
  const totalPages = Math.max(1, Math.ceil(total / limitN));

  ok(res, {
    providers: items.map((p) =>
      toPublicProviderCard(p, {
        distanceKm: hasLocation ? Math.round((p.distanceMeters / 1000) * 10) / 10 : null,
        etaMinutes: hasLocation
          ? estimatedTravelMinutes(p.distanceMeters, settings.avgUrbanSpeedKmh)
          : null,
        matchingScore: Math.round(p.matchingScore * 1000) / 1000,
      })
    ),
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
      radiusKm: radiusMeters / 1000,
      widened: hasLocation && radiusMeters / 1000 > baseKm,
    },
  }, 'Providers fetched successfully');
});

const LAHORE_CENTRE = [74.3587, 31.5204];
/** Without a customer location, the search spans the whole metro area. */
const CITY_RADIUS_KM = 40;
/** Rings tried, in order, after the configured radius finds no one. */
const WIDER_RINGS_KM = [30, 60];

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPipeline({ centre, radiusMeters, match, weights, hasLocation, sortBy, pageN, limitN }) {
  const pipeline = [
    // $geoNear MUST be the first stage; spherical distances in metres.
    {
      $geoNear: {
        near: { type: 'Point', coordinates: centre },
        distanceField: 'distanceMeters',
        maxDistance: radiusMeters,
        spherical: true,
        query: match,
      },
    },
  ];
  if (hasLocation) {
    // Each provider's own reach: someone who serves 10 km is not offered to a
    // customer 20 km away, however wide the search ring.
    pipeline.push({
      $match: {
        $expr: {
          $lte: ['$distanceMeters', { $multiply: [{ $ifNull: ['$serviceRadius', 15] }, 1000] }],
        },
      },
    });
  }
  pipeline.push(
    {
      // score = w_d*(1 - min(d/radius,1)) + w_r*(rating/5) + w_a*(isOnline?1:0)
      // Without a customer location distance says nothing, so it scores
      // every provider the same.
      $addFields: {
        matchingScore: {
          $add: [
            hasLocation
              ? {
                  $multiply: [
                    weights.distance,
                    { $subtract: [1, { $min: [{ $divide: ['$distanceMeters', radiusMeters] }, 1] }] },
                  ],
                }
              : weights.distance * 0.5,
            { $multiply: [weights.rating, { $divide: [{ $ifNull: ['$ratings.average', 0] }, 5] }] },
            { $multiply: [weights.availability, { $cond: [{ $eq: ['$isOnline', true] }, 1, 0] }] },
          ],
        },
      },
    },
    { $sort: buildSort(sortBy, hasLocation) },
    {
      $facet: {
        items: [{ $skip: (pageN - 1) * limitN }, { $limit: limitN }],
        total: [{ $count: 'count' }],
      },
    }
  );
  return pipeline;
}

function buildSort(sortBy, hasLocation = true) {
  switch (sortBy) {
    case 'rating':
      return { 'ratings.average': -1, matchingScore: -1 };
    case 'price_low':
      return { basePrice: 1, matchingScore: -1 };
    case 'price_high':
      return { basePrice: -1, matchingScore: -1 };
    case 'distance':
      // Nearest-first means nothing without knowing where "here" is.
      return hasLocation ? { distanceMeters: 1 } : { matchingScore: -1, 'ratings.average': -1 };
    default:
      return { matchingScore: -1, distanceMeters: 1 };
  }
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

module.exports = { searchProviders, getProviderDetails, getProviderReviews, escapeRegex, buildPipeline };
