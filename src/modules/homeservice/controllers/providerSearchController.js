const asyncHandler = require('express-async-handler');
const Provider = require('../../../models/Provider');
const Booking = require('../models/Booking');
const ProviderReview = require('../models/ProviderReview');
const { getHomeserviceSettings } = require('../services/settingsService');
const { estimatedTravelMinutes } = require('../services/matchingService');
const { toProviderCard, CATEGORY_TO_SUBTYPE, avatar } = require('../services/serializers');

const ok = (res, data, message, pagination) =>
  res.json({ success: true, data, message, ...(pagination ? { pagination } : {}) });

const HS_CATEGORIES = Object.keys(CATEGORY_TO_SUBTYPE); // electricians | plumbers | ac-repairers

/**
 * GET /api/providers — home-service discovery with $geoNear + weighted score.
 * Falls through (next()) to the legacy provider listing when the request is
 * not a home-service search (no recognised category param).
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
  if (!cat || !HS_CATEGORIES.includes(cat)) {
    return next(); // not a home-service search — legacy /api/providers handles it
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
  const fVerified = verified === 'true' || parsedFilters.verified === true;
  const fAvailable = available === 'true' || parsedFilters.available === true;

  const settings = await getHomeserviceSettings();
  const weights = settings.matchingWeights;
  const radiusMeters = (Number(radiusKm) || settings.defaultSearchRadiusKm) * 1000;

  const centre = [
    Number(lng) || 74.3587, // Lahore centre fallback when the app sends no location
    Number(lat) || 31.5204,
  ];

  const match = {
    providerType: 'home_service',
    providerSubType: CATEGORY_TO_SUBTYPE[cat],
    adminVerified: 'active',
    status: { $ne: 'inactive' },
  };
  if (fMinRating) match['ratings.average'] = { $gte: fMinRating };
  if (fMaxPrice) match.basePrice = { $lte: fMaxPrice };
  if (fVerified) match.adminVerified = 'active';
  if (fAvailable) match.isAvailable = true;
  if (search) {
    match.$or = [
      { fullName: { $regex: search, $options: 'i' } },
      { profession: { $regex: search, $options: 'i' } },
      { briefDescription: { $regex: search, $options: 'i' } },
    ];
  }

  const pageN = parseInt(page, 10) || 1;
  const limitN = parseInt(limit, 10) || 15;

  // $geoNear MUST be the first stage; spherical distances in metres.
  const pipeline = [
    {
      $geoNear: {
        near: { type: 'Point', coordinates: centre },
        distanceField: 'distanceMeters',
        maxDistance: radiusMeters,
        spherical: true,
        query: match,
      },
    },
    {
      // score = w_d*(1 - min(d/radius,1)) + w_r*(rating/5) + w_a*(isOnline?1:0)
      $addFields: {
        matchingScore: {
          $add: [
            {
              $multiply: [
                weights.distance,
                {
                  $subtract: [
                    1,
                    { $min: [{ $divide: ['$distanceMeters', radiusMeters] }, 1] },
                  ],
                },
              ],
            },
            {
              $multiply: [
                weights.rating,
                { $divide: [{ $ifNull: ['$ratings.average', 0] }, 5] },
              ],
            },
            {
              $multiply: [
                weights.availability,
                { $cond: [{ $eq: ['$isOnline', true] }, 1, 0] },
              ],
            },
          ],
        },
      },
    },
    { $sort: buildSort(sortBy || sort) },
    {
      $facet: {
        items: [{ $skip: (pageN - 1) * limitN }, { $limit: limitN }],
        total: [{ $count: 'count' }],
      },
    },
  ];

  const [result] = await Provider.aggregate(pipeline);
  const items = result.items || [];
  const total = (result.total[0] && result.total[0].count) || 0;
  const totalPages = Math.max(1, Math.ceil(total / limitN));

  ok(res, {
    providers: items.map((p) =>
      toProviderCard(p, {
        distanceKm: Math.round((p.distanceMeters / 1000) * 10) / 10,
        etaMinutes: estimatedTravelMinutes(p.distanceMeters, settings.avgUrbanSpeedKmh),
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
  }, 'Providers fetched successfully');
});

function buildSort(sortBy) {
  switch (sortBy) {
    case 'rating':
      return { 'ratings.average': -1, matchingScore: -1 };
    case 'price_low':
      return { basePrice: 1, matchingScore: -1 };
    case 'price_high':
      return { basePrice: -1, matchingScore: -1 };
    case 'distance':
      return { distanceMeters: 1 };
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

  const reviews = await ProviderReview.find({ provider: p._id })
    .populate('customer', 'fullName profilePhoto')
    .sort({ createdAt: -1 })
    .limit(10);

  const completedJobs = await Booking.countDocuments({
    provider: p._id,
    status: 'COMPLETED',
  });

  const AVATAR_COLORS = ['#4F46E5', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6'];

  ok(res, {
    ...toProviderCard(p),
    completedJobs,
    servicesOffered: [
      {
        id: '1',
        name: 'Standard Visit',
        description: 'Inspection and standard repair work',
        price: p.basePrice || 500,
        duration: '1 hour',
        icon: 'settings',
      },
      {
        id: '2',
        name: 'Installation',
        description: 'New installation service',
        price: (p.basePrice || 500) * 2,
        duration: '2-3 hours',
        icon: 'construct',
      },
    ],
    availability: buildAvailability(p),
    gallery: [],
    reviewsList: reviews.map((r, i) => ({
      id: String(r._id),
      reviewerName: r.customer ? r.customer.fullName : 'Customer',
      reviewerInitial: r.customer && r.customer.fullName ? r.customer.fullName[0] : 'C',
      rating: r.rating,
      comment: r.comment || '',
      date: r.createdAt.toISOString().slice(0, 10),
      helpfulCount: 0,
      avatarColor: AVATAR_COLORS[i % AVATAR_COLORS.length],
      tags: r.tags || [],
    })),
  }, 'Provider details fetched');
});

function buildAvailability(p) {
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  return days.map((day, i) => {
    const d = (p.availability && p.availability[day]) || {};
    const hasHours = d.start && d.end;
    return {
      id: String(i + 1),
      day: day[0].toUpperCase() + day.slice(1),
      timeSlots: hasHours ? [`${d.start} - ${d.end}`] : ['09:00 AM - 06:00 PM'],
      available: d.isAvailable !== false,
    };
  });
}

// GET /api/providers/:providerId/reviews — paginated, newest first
const getProviderReviews = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 15;
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
    customerName: r.customer ? r.customer.fullName : 'Customer',
    customerAvatar: avatar(r.customer && r.customer.fullName, r.customer && r.customer.profilePhoto),
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

module.exports = { searchProviders, getProviderDetails, getProviderReviews };
