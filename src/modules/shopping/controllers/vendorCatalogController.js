const asyncHandler = require('express-async-handler');
const Product = require('../models/Product');
const Category = require('../models/Category');
const Order = require('../models/Order');
const InventoryLog = require('../models/InventoryLog');
const { uploadBase64Image } = require('../../../config/cloudinary');
const { getShoppingSettings } = require('../services/settingsService');
const { slugify } = require('../utils/ids');
const { escapeRegex } = require('../services/catalogService');
const { ok, paginated, fail, parsePagination } = require('../utils/respond');

const PRODUCT_EDITABLE = [
  'sku',
  'name',
  'description',
  'images',
  'categoryId',
  'variants',
  'basePrice',
  'salePrice',
  'isFeatured',
  'isNewArrival',
  'tags',
  'isActive',
];

/**
 * ── Products (scoped to req.brand) ─────────────────────────────────
 */

// @desc  GET /api/shopping/vendor/products?search&stockStatus&page&limit
const getMyProducts = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const settings = await getShoppingSettings();
  const filter = { brandId: req.brand._id };
  if (req.query.search) {
    filter.name = new RegExp(escapeRegex(req.query.search), 'i');
  }
  if (req.query.stockStatus === 'out') filter.inStock = false;
  if (req.query.stockStatus === 'in') filter.inStock = true;
  if (req.query.includeInactive !== 'true') filter.isActive = true;

  let query = Product.find(filter).sort({ createdAt: -1 });
  if (req.query.stockStatus !== 'low') query = query.skip(skip).limit(limit);
  let rows = await query;
  let total;

  if (req.query.stockStatus === 'low') {
    rows = rows.filter((p) =>
      p.variants.some((v) => v.stockQuantity > 0 && v.stockQuantity <= settings.lowStockThreshold)
    );
    total = rows.length;
    rows = rows.slice(skip, skip + limit);
  } else {
    total = await Product.countDocuments(filter);
  }
  return paginated(res, { data: rows, page, limit, total });
});

/** salePrice must be a genuine discount, and an SKU (if given) must be
 * unique within the brand — Product.sku has no schema-level constraint. */
const validateProductFields = async (brandId, { basePrice, salePrice, sku }, excludeProductId) => {
  if (salePrice !== undefined && salePrice !== null && salePrice >= basePrice) {
    return `salePrice (${salePrice}) must be lower than basePrice (${basePrice})`;
  }
  if (sku) {
    const dupeFilter = { brandId, sku };
    if (excludeProductId) dupeFilter._id = { $ne: excludeProductId };
    if (await Product.findOne(dupeFilter)) {
      return `SKU "${sku}" is already used by another product in this brand`;
    }
  }
  return null;
};

// @desc  POST /api/shopping/vendor/products
const createProduct = asyncHandler(async (req, res) => {
  if (!req.body.name || req.body.basePrice === undefined) {
    return fail(res, 400, 'name and basePrice are required');
  }
  const validationError = await validateProductFields(req.brand._id, req.body);
  if (validationError) return fail(res, 400, validationError);

  const payload = { brandId: req.brand._id };
  PRODUCT_EDITABLE.forEach((f) => {
    if (req.body[f] !== undefined) payload[f] = req.body[f];
  });
  const product = new Product(payload);
  product.syncStockFlag();
  await product.save();
  return ok(res, product, 201);
});

// @desc  PATCH /api/shopping/vendor/products/:productId
const updateProduct = asyncHandler(async (req, res) => {
  const product = await Product.findOne({ _id: req.params.productId, brandId: req.brand._id });
  if (!product) return fail(res, 404, 'Product not found');

  const validationError = await validateProductFields(
    req.brand._id,
    {
      basePrice: req.body.basePrice !== undefined ? req.body.basePrice : product.basePrice,
      salePrice: req.body.salePrice !== undefined ? req.body.salePrice : product.salePrice,
      sku: req.body.sku !== undefined ? req.body.sku : product.sku,
    },
    product._id
  );
  if (validationError) return fail(res, 400, validationError);

  PRODUCT_EDITABLE.forEach((f) => {
    if (req.body[f] !== undefined) product[f] = req.body[f];
  });
  if (req.body.variants !== undefined) product.syncStockFlag();
  await product.save();
  return ok(res, product);
});

// @desc  DELETE /api/shopping/vendor/products/:productId — soft delete.
// Never hard-deletes: order items reference the product for history.
const deleteProduct = asyncHandler(async (req, res) => {
  const product = await Product.findOne({ _id: req.params.productId, brandId: req.brand._id });
  if (!product) return fail(res, 404, 'Product not found');
  product.isActive = false;
  await product.save();
  return res.json({ success: true });
});

// @desc  POST /api/shopping/vendor/products/:productId/images { images: [base64...] }
const addProductImages = asyncHandler(async (req, res) => {
  const product = await Product.findOne({ _id: req.params.productId, brandId: req.brand._id });
  if (!product) return fail(res, 404, 'Product not found');
  const images = Array.isArray(req.body.images) ? req.body.images : [req.body.image].filter(Boolean);
  if (images.length === 0) return fail(res, 400, 'images (base64 data URIs) are required');
  for (const img of images) {
    const result = await uploadBase64Image(img, 'products');
    product.images.push(result.secure_url || result.url);
  }
  await product.save();
  return ok(res, product);
});

/**
 * ── Categories (scoped to my brand) ────────────────────────────────
 */

const getMyCategories = asyncHandler(async (req, res) => {
  const cats = await Category.find({ brandId: req.brand._id }).sort({ createdAt: 1 });
  return ok(res, cats);
});

const createCategory = asyncHandler(async (req, res) => {
  if (!req.body.name) return fail(res, 400, 'Category name is required');
  const slug = slugify(req.body.slug || req.body.name);
  if (await Category.findOne({ brandId: req.brand._id, slug })) {
    return fail(res, 400, 'A category with this name already exists');
  }
  if (req.body.parentId) {
    const parent = await Category.findOne({ _id: req.body.parentId, brandId: req.brand._id });
    if (!parent) return fail(res, 400, 'Parent category not found');
    if (parent.parentId) return fail(res, 400, 'Categories can only be nested 2 levels deep');
  }
  const category = await Category.create({
    brandId: req.brand._id,
    name: req.body.name,
    slug,
    icon: req.body.icon || '',
    parentId: req.body.parentId || null,
  });
  return ok(res, category, 201);
});

const updateCategory = asyncHandler(async (req, res) => {
  const category = await Category.findOne({ _id: req.params.categoryId, brandId: req.brand._id });
  if (!category) return fail(res, 404, 'Category not found');
  ['name', 'icon', 'isActive'].forEach((f) => {
    if (req.body[f] !== undefined) category[f] = req.body[f];
  });
  await category.save();
  return ok(res, category);
});

const deleteCategory = asyncHandler(async (req, res) => {
  const category = await Category.findOne({ _id: req.params.categoryId, brandId: req.brand._id });
  if (!category) return fail(res, 404, 'Category not found');
  const inUse = await Product.countDocuments({ categoryId: category._id, isActive: true });
  if (inUse > 0) return fail(res, 400, `This category still has ${inUse} active product(s)`);
  category.isActive = false;
  await category.save();
  return res.json({ success: true });
});

/**
 * ── Inventory ──────────────────────────────────────────────────────
 */

// @desc  GET /api/shopping/vendor/inventory — per-variant rows with flags
const getInventory = asyncHandler(async (req, res) => {
  const settings = await getShoppingSettings();
  const products = await Product.find({ brandId: req.brand._id, isActive: true });
  const rows = [];
  products.forEach((p) => {
    p.variants.forEach((v) => {
      rows.push({
        productId: String(p._id),
        productName: p.name,
        productImage: p.images[0] || '',
        variantId: String(v._id),
        variantLabel: [v.size, v.color].filter(Boolean).join(' / '),
        sku: v.sku,
        stockQuantity: v.stockQuantity,
        lowStock: v.stockQuantity > 0 && v.stockQuantity <= settings.lowStockThreshold,
        outOfStock: v.stockQuantity === 0,
      });
    });
  });
  return ok(res, rows);
});

const applyStockChange = async (brand, actor, { variantId, stockQuantity, reason }) => {
  const product = await Product.findOne({ brandId: brand._id, 'variants._id': variantId });
  if (!product) return { ok: false, reason: `Variant ${variantId} not found` };
  const variant = product.variants.id(variantId);
  const newQuantity = Number(stockQuantity);
  if (Number.isNaN(newQuantity) || newQuantity < 0) {
    return { ok: false, reason: 'stockQuantity must be a non-negative number' };
  }
  const delta = newQuantity - variant.stockQuantity;
  variant.stockQuantity = newQuantity;
  product.syncStockFlag();
  await product.save();
  await InventoryLog.create({
    brandId: brand._id,
    product: product._id,
    variantId,
    delta,
    newQuantity,
    reason: reason || 'Manual adjustment',
    actor,
  });
  return { ok: true };
};

// @desc  PATCH /api/shopping/vendor/inventory/:variantId { stockQuantity, reason }
const updateStock = asyncHandler(async (req, res) => {
  const result = await applyStockChange(req.brand, { id: req.user._id, role: 'vendor' }, {
    variantId: req.params.variantId,
    stockQuantity: req.body.stockQuantity,
    reason: req.body.reason,
  });
  if (!result.ok) return fail(res, 400, result.reason);
  return res.json({ success: true });
});

// @desc  POST /api/shopping/vendor/inventory/bulk { updates: [{variantId, stockQuantity, reason}] }
const bulkUpdateStock = asyncHandler(async (req, res) => {
  if (!Array.isArray(req.body.updates) || req.body.updates.length === 0) {
    return fail(res, 400, 'updates[] is required');
  }
  const results = [];
  for (const update of req.body.updates) {
    const result = await applyStockChange(
      req.brand,
      { id: req.user._id, role: 'vendor' },
      update
    );
    results.push({ variantId: update.variantId, ...result });
  }
  return ok(res, results);
});

module.exports = {
  getMyProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  addProductImages,
  getMyCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  getInventory,
  updateStock,
  bulkUpdateStock,
};
