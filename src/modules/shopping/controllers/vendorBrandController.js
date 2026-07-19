const asyncHandler = require('express-async-handler');
const Brand = require('../models/Brand');
const Coupon = require('../models/Coupon');
const ProductReview = require('../models/ProductReview');
const { uploadBase64Image } = require('../../../config/cloudinary');
const { getShoppingSettings } = require('../services/settingsService');
const { slugify } = require('../utils/ids');
const { ok, paginated, fail, parsePagination } = require('../utils/respond');

const BRAND_EDITABLE = [
  'name',
  'description',
  'tagline',
  'primaryColor',
  'secondaryColor',
  'accentColor',
  'categories',
  'policies',
  'contactEmail',
  'contactPhone',
  'website',
  'socialLinks',
];

// @desc  POST /api/shopping/vendor/brand — create my brand profile
const createMyBrand = asyncHandler(async (req, res) => {
  const existing = await Brand.findOne({ owner: req.user._id, isDeleted: false });
  if (existing) return fail(res, 400, 'You already have a brand profile');
  if (!req.body.name) return fail(res, 400, 'Brand name is required');

  const slug = slugify(req.body.slug || req.body.name);
  if (await Brand.findOne({ slug })) {
    return fail(res, 400, 'A brand with this name/slug already exists');
  }

  const settings = await getShoppingSettings();
  const payload = { owner: req.user._id, slug, status: settings.autoApproveBrands ? 'active' : 'pending' };
  BRAND_EDITABLE.forEach((f) => {
    if (req.body[f] !== undefined) payload[f] = req.body[f];
  });
  const brand = await Brand.create(payload);
  return ok(res, brand, 201);
});

// @desc  GET /api/shopping/vendor/brand — my brand
const getMyBrand = asyncHandler(async (req, res) => ok(res, req.brand));

// @desc  PATCH /api/shopping/vendor/brand
const updateMyBrand = asyncHandler(async (req, res) => {
  const brand = req.brand;
  BRAND_EDITABLE.forEach((f) => {
    if (req.body[f] !== undefined) {
      if ((f === 'policies' || f === 'socialLinks') && typeof req.body[f] === 'object') {
        brand[f] = { ...(brand[f] ? brand[f].toObject() : {}), ...req.body[f] };
      } else {
        brand[f] = req.body[f];
      }
    }
  });
  await brand.save();
  return ok(res, brand);
});

// @desc  POST /api/shopping/vendor/brand/logo  (and /banner)
// Accepts { image: <base64 data URI> } and reuses the existing Cloudinary helper.
const uploadBrandImage = (field) =>
  asyncHandler(async (req, res) => {
    if (!req.body.image) return fail(res, 400, 'image (base64 data URI) is required');
    const result = await uploadBase64Image(req.body.image, 'brands');
    req.brand[field] = result.secure_url || result.url;
    await req.brand.save();
    return ok(res, req.brand);
  });

/**
 * ── Coupons (mine) ─────────────────────────────────────────────────
 */

// @desc  GET /api/shopping/vendor/coupons
const getMyCoupons = asyncHandler(async (req, res) => {
  const coupons = await Coupon.find({ brandId: req.brand._id }).sort({ createdAt: -1 });
  return ok(res, coupons);
});

// @desc  POST /api/shopping/vendor/coupons
const createCoupon = asyncHandler(async (req, res) => {
  const { couponCode, type, value, validFrom, validUntil } = req.body;
  if (!couponCode || !type || value === undefined || !validFrom || !validUntil) {
    return fail(res, 400, 'couponCode, type, value, validFrom and validUntil are required');
  }
  if (await Coupon.findOne({ couponCode: String(couponCode).toUpperCase() })) {
    return fail(res, 400, 'This coupon code is already in use');
  }
  const coupon = await Coupon.create({
    couponCode,
    brandId: req.brand._id,
    type,
    value,
    minOrderAmount: req.body.minOrderAmount || 0,
    maxDiscount: req.body.maxDiscount || 0,
    validFrom,
    validUntil,
    usageLimit: req.body.usageLimit || 0,
    createdBy: { id: req.user._id, role: 'vendor' },
  });
  return ok(res, coupon, 201);
});

// @desc  PATCH /api/shopping/vendor/coupons/:couponCode
const updateCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findOne({
    couponCode: String(req.params.couponCode).toUpperCase(),
    brandId: req.brand._id,
  });
  if (!coupon) return fail(res, 404, 'Coupon not found');
  ['value', 'minOrderAmount', 'maxDiscount', 'validFrom', 'validUntil', 'usageLimit', 'isActive'].forEach(
    (f) => {
      if (req.body[f] !== undefined) coupon[f] = req.body[f];
    }
  );
  await coupon.save();
  return ok(res, coupon);
});

/**
 * ── Reviews across my products ─────────────────────────────────────
 */

// @desc  GET /api/shopping/vendor/reviews?rating&page&limit
const getMyReviews = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = { brandId: req.brand._id };
  if (req.query.rating) filter.rating = Number(req.query.rating);
  const [reviews, total] = await Promise.all([
    ProductReview.find(filter)
      .populate('userId', 'name fullName profilePicture')
      .populate('productId', 'name images')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    ProductReview.countDocuments(filter),
  ]);
  const data = reviews.map((r) => {
    const json = r.toJSON();
    if (r.productId && r.productId.name) {
      json.productName = r.productId.name;
      json.productImage = (r.productId.images && r.productId.images[0]) || '';
      json.productId = String(r.productId._id);
    }
    return json;
  });
  return paginated(res, { data, page, limit, total });
});

// @desc  POST /api/shopping/vendor/reviews/:reviewId/respond { response }
const respondToReview = asyncHandler(async (req, res) => {
  if (!req.body.response) return fail(res, 400, 'response text is required');
  const review = await ProductReview.findOne({ _id: req.params.reviewId, brandId: req.brand._id });
  if (!review) return fail(res, 404, 'Review not found');
  review.vendorResponse = req.body.response;
  await review.save();
  return ok(res, review);
});

module.exports = {
  createMyBrand,
  getMyBrand,
  updateMyBrand,
  uploadBrandLogo: uploadBrandImage('logo'),
  uploadBrandBanner: uploadBrandImage('bannerImage'),
  getMyCoupons,
  createCoupon,
  updateCoupon,
  getMyReviews,
  respondToReview,
};
