const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const recs = require('../services/recsService');

const ok = (res, data) => res.json({ success: true, data });

function origin(q) {
  const lat = Number(q.lat);
  const lng = Number(q.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
}

/** ?brandId= keeps a shelf inside one storefront (the shopping home is per store). */
function scope(req) {
  const b = req.query.brandId;
  if (b === undefined || b === '') return { brandId: null };
  if (!mongoose.isValidObjectId(b)) {
    const err = new Error('Invalid brand id');
    err.statusCode = 400;
    throw err;
  }
  return { brandId: String(b) };
}

// GET /api/recommendations/shopping?brandId=     (signed in → personal; otherwise popular)
const shopping = asyncHandler(async (req, res) =>
  ok(res, await recs.shoppingForUser(req.user && !req.isProvider && !req.isAdmin ? req.user._id : null, scope(req)))
);

// GET /api/recommendations/shopping/similar/:productId?brandId=
const similar = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.productId)) {
    res.status(400);
    throw new Error('Invalid product id');
  }
  ok(res, await recs.similarProducts(req.params.productId, scope(req)));
});

// GET /api/recommendations/shopping/trending?brandId=
const trending = asyncHandler(async (req, res) => ok(res, await recs.trending(scope(req))));

// GET /api/recommendations/homeservice?lat&lng
const homeservice = asyncHandler(async (req, res) => ok(res, await recs.homeserviceForUser(req.user._id, origin(req.query))));

// GET /api/recommendations/healthcare?lat&lng
const healthcare = asyncHandler(async (req, res) => ok(res, await recs.doctorsForUser(req.user._id, origin(req.query))));

module.exports = { shopping, similar, trending, homeservice, healthcare };
