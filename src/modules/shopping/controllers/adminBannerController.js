const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const ShoppingBanner = require('../models/ShoppingBanner');
const Brand = require('../models/Brand');
const Product = require('../models/Product');
const { audit } = require('../middleware/adminAuth');
const { uploadBase64Image } = require('../../../config/cloudinary');
const { ok, paginated, fail, parsePagination } = require('../utils/respond');

const BANNER_FIELDS = [
  'title',
  'subtitle',
  'image',
  'brandId',
  'productId',
  'sortOrder',
  'isActive',
  'validFrom',
  'validUntil',
];

const isCastError = (e) =>
  e.name === 'CastError' || e.name === 'BSONError' || e.name === 'BSONTypeError';

/**
 * Deep-link targets are validated on write rather than on read: a banner that
 * points at a brand or product that does not exist would send the shopper to
 * an error screen, and the admin who created it would never find out.
 */
const validateTargets = async ({ brandId, productId }) => {
  if (brandId) {
    if (!mongoose.isValidObjectId(brandId)) return 'brandId is not a valid id';
    const brand = await Brand.findOne({ _id: brandId, isDeleted: false });
    if (!brand) return 'That brand does not exist';
  }
  if (productId) {
    if (!mongoose.isValidObjectId(productId)) return 'productId is not a valid id';
    const product = await Product.findById(productId);
    if (!product) return 'That product does not exist';
  }
  return null;
};

/** Empty string from a form field means "clear it", not "set it to ''". */
const normaliseTarget = (v) => (v === '' || v === undefined ? undefined : v || null);

// @desc  GET /api/shopping/admin/banners — every banner, live or not
const listBanners = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};
  if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';
  const [banners, total] = await Promise.all([
    ShoppingBanner.find(filter).sort({ sortOrder: 1, createdAt: -1 }).skip(skip).limit(limit),
    ShoppingBanner.countDocuments(filter),
  ]);
  return paginated(res, { data: banners.map((b) => b.toJSON()), page, limit, total });
});

// @desc  POST /api/shopping/admin/banners
const createBanner = asyncHandler(async (req, res) => {
  const { title, image } = req.body;
  if (!title || !image) return fail(res, 400, 'title and image are required');

  const brandId = normaliseTarget(req.body.brandId) || null;
  const productId = normaliseTarget(req.body.productId) || null;
  const invalid = await validateTargets({ brandId, productId });
  if (invalid) return fail(res, 400, invalid);

  const banner = await ShoppingBanner.create({
    title,
    subtitle: req.body.subtitle || '',
    image,
    brandId,
    productId,
    sortOrder: Number(req.body.sortOrder) || 0,
    isActive: req.body.isActive !== undefined ? Boolean(req.body.isActive) : true,
    validFrom: req.body.validFrom || null,
    validUntil: req.body.validUntil || null,
  });
  await audit(req.user._id, 'create_banner', 'ShoppingBanner', banner._id, {
    after: banner.toJSON(),
  });
  return ok(res, banner, 201);
});

// @desc  PATCH /api/shopping/admin/banners/:bannerId
const updateBanner = asyncHandler(async (req, res) => {
  try {
    const banner = await ShoppingBanner.findById(req.params.bannerId);
    if (!banner) return fail(res, 404, 'Banner not found');

    const nextBrand =
      req.body.brandId !== undefined ? normaliseTarget(req.body.brandId) : banner.brandId;
    const nextProduct =
      req.body.productId !== undefined ? normaliseTarget(req.body.productId) : banner.productId;
    const invalid = await validateTargets({ brandId: nextBrand, productId: nextProduct });
    if (invalid) return fail(res, 400, invalid);

    const before = banner.toJSON();
    BANNER_FIELDS.forEach((f) => {
      if (req.body[f] === undefined) return;
      if (f === 'brandId') banner.brandId = nextBrand;
      else if (f === 'productId') banner.productId = nextProduct;
      else if (f === 'sortOrder') banner.sortOrder = Number(req.body.sortOrder) || 0;
      else if (f === 'isActive') banner.isActive = Boolean(req.body.isActive);
      else if (f === 'validFrom' || f === 'validUntil') banner[f] = req.body[f] || null;
      else banner[f] = req.body[f];
    });
    await banner.save();
    await audit(req.user._id, 'update_banner', 'ShoppingBanner', banner._id, {
      before,
      after: banner.toJSON(),
    });
    return ok(res, banner);
  } catch (e) {
    if (isCastError(e)) return fail(res, 400, 'Invalid banner ID');
    throw e;
  }
});

// @desc  DELETE /api/shopping/admin/banners/:bannerId
const deleteBanner = asyncHandler(async (req, res) => {
  try {
    const banner = await ShoppingBanner.findById(req.params.bannerId);
    if (!banner) return fail(res, 404, 'Banner not found');
    const before = banner.toJSON();
    await banner.deleteOne();
    await audit(req.user._id, 'delete_banner', 'ShoppingBanner', req.params.bannerId, { before });
    return res.json({ success: true });
  } catch (e) {
    if (isCastError(e)) return fail(res, 400, 'Invalid banner ID');
    throw e;
  }
});

// @desc  POST /api/shopping/admin/banners/:bannerId/image { image: <base64 data URI> }
const uploadBannerImage = asyncHandler(async (req, res) => {
  if (!req.body.image) return fail(res, 400, 'image (base64 data URI) is required');
  try {
    const banner = await ShoppingBanner.findById(req.params.bannerId);
    if (!banner) return fail(res, 404, 'Banner not found');
    const result = await uploadBase64Image(req.body.image, 'shopping-banners');
    banner.image = result.secure_url || result.url;
    await banner.save();
    return ok(res, banner);
  } catch (e) {
    if (isCastError(e)) return fail(res, 400, 'Invalid banner ID');
    throw e;
  }
});

module.exports = {
  listBanners,
  createBanner,
  updateBanner,
  deleteBanner,
  uploadBannerImage,
};
