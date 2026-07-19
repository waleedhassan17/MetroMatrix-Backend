const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Brand = require('../models/Brand');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Outlet = require('../models/Outlet');
const { audit } = require('../middleware/adminAuth');
const { slugify } = require('../utils/ids');
const { escapeRegex } = require('../services/catalogService');
const { ok, paginated, fail, parsePagination } = require('../utils/respond');

const BRAND_FIELDS = [
  'name',
  'description',
  'tagline',
  'logo',
  'bannerImage',
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

/**
 * ── Brand oversight ────────────────────────────────────────────────
 */

// @desc  GET /api/shopping/admin/brands?status&search&page&limit
const listBrands = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = { isDeleted: false };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.search) filter.name = new RegExp(escapeRegex(req.query.search), 'i');
  const [brands, total] = await Promise.all([
    Brand.find(filter).populate('owner', 'fullName email').sort({ createdAt: -1 }).skip(skip).limit(limit),
    Brand.countDocuments(filter),
  ]);
  const data = brands.map((b) => {
    const json = b.toJSON();
    json.status = b.status;
    if (b.owner && typeof b.owner === 'object') {
      json.ownerName = b.owner.fullName;
      json.ownerEmail = b.owner.email;
      json.owner = String(b.owner._id);
    }
    return json;
  });
  return paginated(res, { data, page, limit, total });
});

// @desc  GET /api/shopping/admin/brands/:brandId — detail + counts + revenue
const getBrandDetail = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.brandId)) return fail(res, 400, 'Invalid brand ID');
  const brand = await Brand.findOne({ _id: req.params.brandId, isDeleted: false }).populate(
    'owner',
    'fullName email phoneNumber providerType adminVerified'
  );
  if (!brand) return fail(res, 404, 'Brand not found');

  const [productCount, orderCount, revenueAgg] = await Promise.all([
    Product.countDocuments({ brandId: brand._id, isActive: true }),
    Order.countDocuments({ brandId: brand._id }),
    Order.aggregate([
      { $match: { brandId: brand._id, orderStatus: 'delivered' } },
      { $group: { _id: null, revenue: { $sum: '$total' } } },
    ]),
  ]);
  const json = brand.toJSON();
  json.status = brand.status;
  json.productCount = productCount;
  json.orderCount = orderCount;
  json.revenue = revenueAgg.length ? revenueAgg[0].revenue : 0;
  return ok(res, json);
});

// @desc  POST /api/shopping/admin/brands — admin-created brand (AddBrandScreen)
const createBrand = asyncHandler(async (req, res) => {
  if (!req.body.name) return fail(res, 400, 'Brand name is required');
  const slug = slugify(req.body.slug || req.body.name);
  if (await Brand.findOne({ slug })) return fail(res, 400, 'A brand with this slug already exists');

  const payload = { slug, status: 'active', approvedBy: req.user._id, approvedAt: new Date() };
  BRAND_FIELDS.forEach((f) => {
    if (req.body[f] !== undefined) payload[f] = req.body[f];
  });
  if (req.body.isActive === false) payload.status = 'suspended';
  const brand = await Brand.create(payload);
  await audit(req.user._id, 'create_brand', 'Brand', brand._id, { after: brand.toJSON() });
  return ok(res, brand, 201);
});

// @desc  PATCH /api/shopping/admin/brands/:brandId — admin edit (EditBrandScreen)
const updateBrand = asyncHandler(async (req, res) => {
  const brand = await Brand.findOne({ _id: req.params.brandId, isDeleted: false });
  if (!brand) return fail(res, 404, 'Brand not found');
  const before = brand.toJSON();
  BRAND_FIELDS.forEach((f) => {
    if (req.body[f] !== undefined) {
      if ((f === 'policies' || f === 'socialLinks') && typeof req.body[f] === 'object') {
        brand[f] = { ...(brand[f] ? brand[f].toObject() : {}), ...req.body[f] };
      } else {
        brand[f] = req.body[f];
      }
    }
  });
  // EditBrandScreen sends isActive — map onto the status enum
  if (req.body.isActive === true && brand.status !== 'active') brand.status = 'active';
  if (req.body.isActive === false && brand.status === 'active') brand.status = 'suspended';
  await brand.save();
  await audit(req.user._id, 'update_brand', 'Brand', brand._id, { before, after: brand.toJSON() });
  return ok(res, brand);
});

// @desc  PATCH /api/shopping/admin/brands/:brandId/status { status, reason }
// Suspending immediately hides the brand and its products from every
// customer-facing endpoint (all customer reads filter status='active').
const setBrandStatus = asyncHandler(async (req, res) => {
  const { status, reason } = req.body;
  if (!['active', 'suspended', 'pending'].includes(status)) {
    return fail(res, 400, "status must be 'active', 'suspended' or 'pending'");
  }
  const brand = await Brand.findOne({ _id: req.params.brandId, isDeleted: false });
  if (!brand) return fail(res, 404, 'Brand not found');
  const before = { status: brand.status };
  brand.status = status;
  if (status === 'active') {
    brand.approvedBy = req.user._id;
    brand.approvedAt = new Date();
  }
  await brand.save();
  await audit(req.user._id, 'set_brand_status', 'Brand', brand._id, {
    before,
    after: { status },
    reason,
  });
  const json = brand.toJSON();
  json.status = brand.status;
  return ok(res, json);
});

// @desc  DELETE /api/shopping/admin/brands/:brandId — soft delete only
const deleteBrand = asyncHandler(async (req, res) => {
  const brand = await Brand.findOne({ _id: req.params.brandId, isDeleted: false });
  if (!brand) return fail(res, 404, 'Brand not found');
  brand.isDeleted = true;
  brand.status = 'suspended';
  await brand.save();
  await audit(req.user._id, 'delete_brand', 'Brand', brand._id, { reason: req.body.reason });
  return res.json({ success: true });
});

/**
 * ── Outlet management (matches outletApi.ts) ───────────────────────
 */

const OUTLET_FIELDS = [
  'name',
  'description',
  'colorScheme',
  'phone',
  'email',
  'openingHours',
  'managerName',
  'isActive',
  'images',
  'floorArea',
];

const applyOutletPayload = (outlet, body) => {
  OUTLET_FIELDS.forEach((f) => {
    if (body[f] !== undefined) outlet[f] = body[f];
  });
  if (body.brandId !== undefined) outlet.brandId = body.brandId || null;
  if (body.location) {
    const { latitude, longitude, ...rest } = body.location;
    outlet.location = { ...(outlet.location ? outlet.location.toObject() : {}), ...rest };
    if (latitude !== undefined && longitude !== undefined) {
      outlet.geo = { type: 'Point', coordinates: [longitude, latitude] };
    }
  }
};

const listOutletsAdmin = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};
  if (req.query.brandId) filter.brandId = req.query.brandId;
  const [outlets, total] = await Promise.all([
    Outlet.find(filter).populate('brandId', 'name primaryColor').sort({ createdAt: -1 }).skip(skip).limit(limit),
    Outlet.countDocuments(filter),
  ]);
  return paginated(res, { data: outlets, page, limit, total });
});

const getOutletAdmin = asyncHandler(async (req, res) => {
  const outlet = await Outlet.findById(req.params.outletId).populate('brandId', 'name primaryColor');
  if (!outlet) return fail(res, 404, 'Outlet not found');
  return ok(res, outlet);
});

const createOutlet = asyncHandler(async (req, res) => {
  if (!req.body.name) return fail(res, 400, 'Outlet name is required');
  const outlet = new Outlet({ slug: slugify(req.body.slug || req.body.name) });
  applyOutletPayload(outlet, req.body);
  outlet.name = req.body.name;
  await outlet.save();
  await audit(req.user._id, 'create_outlet', 'Outlet', outlet._id, { after: outlet.toJSON() });
  await outlet.populate('brandId', 'name primaryColor');
  return ok(res, outlet, 201);
});

const updateOutlet = asyncHandler(async (req, res) => {
  const outlet = await Outlet.findById(req.params.outletId);
  if (!outlet) return fail(res, 404, 'Outlet not found');
  const before = outlet.toJSON();
  applyOutletPayload(outlet, req.body);
  await outlet.save();
  await audit(req.user._id, 'update_outlet', 'Outlet', outlet._id, { before, after: outlet.toJSON() });
  await outlet.populate('brandId', 'name primaryColor');
  return ok(res, outlet);
});

const deleteOutlet = asyncHandler(async (req, res) => {
  const outlet = await Outlet.findById(req.params.outletId);
  if (!outlet) return fail(res, 404, 'Outlet not found');
  await outlet.deleteOne();
  await audit(req.user._id, 'delete_outlet', 'Outlet', outlet._id, { before: outlet.toJSON() });
  return res.json({ success: true });
});

// PATCH /admin/outlets/:outletId/assign-brand { brandId }
const assignBrand = asyncHandler(async (req, res) => {
  const outlet = await Outlet.findById(req.params.outletId);
  if (!outlet) return fail(res, 404, 'Outlet not found');
  if (req.body.brandId) {
    const brand = await Brand.findOne({ _id: req.body.brandId, isDeleted: false });
    if (!brand) return fail(res, 404, 'Brand not found');
    outlet.brandId = brand._id;
  } else {
    outlet.brandId = null;
  }
  await outlet.save();
  await audit(req.user._id, 'assign_outlet_brand', 'Outlet', outlet._id, {
    after: { brandId: req.body.brandId },
  });
  await outlet.populate('brandId', 'name primaryColor');
  return ok(res, outlet);
});

// PATCH /admin/outlets/:outletId/color-scheme
const updateColorScheme = asyncHandler(async (req, res) => {
  const outlet = await Outlet.findById(req.params.outletId);
  if (!outlet) return fail(res, 404, 'Outlet not found');
  outlet.colorScheme = req.body.colorScheme || req.body;
  await outlet.save();
  await outlet.populate('brandId', 'name primaryColor');
  return ok(res, outlet);
});

// PATCH /admin/outlets/:outletId/toggle-status
const toggleOutletStatus = asyncHandler(async (req, res) => {
  const outlet = await Outlet.findById(req.params.outletId);
  if (!outlet) return fail(res, 404, 'Outlet not found');
  outlet.isActive = !outlet.isActive;
  await outlet.save();
  await audit(req.user._id, 'toggle_outlet_status', 'Outlet', outlet._id, {
    after: { isActive: outlet.isActive },
  });
  await outlet.populate('brandId', 'name primaryColor');
  return ok(res, outlet);
});

module.exports = {
  listBrands,
  getBrandDetail,
  createBrand,
  updateBrand,
  setBrandStatus,
  deleteBrand,
  listOutletsAdmin,
  getOutletAdmin,
  createOutlet,
  updateOutlet,
  deleteOutlet,
  assignBrand,
  updateColorScheme,
  toggleOutletStatus,
};
