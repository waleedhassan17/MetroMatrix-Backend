const mongoose = require('mongoose');
const Brand = require('../models/Brand');
const Category = require('../models/Category');
const Product = require('../models/Product');
const Outlet = require('../models/Outlet');

/**
 * Pure query builders — exported separately so filter/sort/pagination
 * logic is unit-testable without a database.
 */

// Matches FetchProductsParams in the frontend's networks/shopping/productApi.ts
const buildProductQuery = (params = {}, activeBrandIds = null) => {
  const query = { isActive: true };

  if (params.brandId) query.brandId = params.brandId;
  else if (activeBrandIds) query.brandId = { $in: activeBrandIds };

  if (params.categoryId) query.categoryId = params.categoryId;
  if (params.gender) query.tags = String(params.gender).trim().toLowerCase();
  if (parseBool(params.isFeatured)) query.isFeatured = true;
  if (parseBool(params.isNewArrival)) query.isNewArrival = true;
  if (parseBool(params.inStock)) query.inStock = true;

  const min = params.minPrice !== undefined ? Number(params.minPrice) : undefined;
  const max = params.maxPrice !== undefined ? Number(params.maxPrice) : undefined;
  // Effective price = salePrice when set, else basePrice
  const priceExpr = { $ifNull: ['$salePrice', '$basePrice'] };
  const priceConds = [];
  if (!Number.isNaN(min) && min !== undefined) priceConds.push({ $gte: [priceExpr, min] });
  if (!Number.isNaN(max) && max !== undefined) priceConds.push({ $lte: [priceExpr, max] });
  if (priceConds.length) {
    query.$expr = priceConds.length === 1 ? priceConds[0] : { $and: priceConds };
  }

  if (params.search) {
    const rx = new RegExp(escapeRegex(String(params.search).trim()), 'i');
    query.$or = [{ name: rx }, { description: rx }, { tags: rx }];
  }

  return query;
};

const buildProductSort = (sortBy) => {
  switch (sortBy) {
    case 'price_asc':
      return { effectivePrice: 1 };
    case 'price_desc':
      return { effectivePrice: -1 };
    case 'rating':
      return { rating: -1 };
    case 'newest':
      return { createdAt: -1 };
    case 'popular':
    default:
      return { totalReviews: -1 };
  }
};

// Assemble a flat category list into the 2-level tree the FE renders
const buildCategoryTree = (categories, productCounts = {}) => {
  const byId = new Map();
  categories.forEach((c) => {
    const json = typeof c.toJSON === 'function' ? c.toJSON() : { ...c };
    json.children = [];
    json.productCount = productCounts[json.categoryId] || 0;
    byId.set(json.categoryId, json);
  });
  const roots = [];
  byId.forEach((cat) => {
    if (cat.parentId && byId.has(cat.parentId)) {
      const parent = byId.get(cat.parentId);
      parent.children.push(cat);
      parent.productCount += cat.productCount;
    } else {
      roots.push(cat);
    }
  });
  return roots;
};

const parseBool = (v) => v === true || v === 'true' || v === '1' || v === 1;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * DB-backed reads
 */

const listActiveBrands = async ({ skip, limit }) => {
  const filter = { status: 'active', isDeleted: false };
  const [brands, total] = await Promise.all([
    Brand.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Brand.countDocuments(filter),
  ]);
  return { brands, total };
};

const listProducts = async (params, { page, limit, skip }) => {
  // Products of suspended/pending brands must never be customer-visible
  const activeBrands = params.brandId
    ? null
    : (await Brand.find({ status: 'active', isDeleted: false }).select('_id')).map((b) => b._id);

  const queryParams = { ...params };
  if (params.brandId) {
    const brand = await Brand.findOne({ _id: params.brandId, status: 'active', isDeleted: false });
    if (!brand) return { products: [], total: 0 };
    // Aggregation $match does NOT auto-cast strings to ObjectId
    queryParams.brandId = brand._id;
  }
  if (params.categoryId && mongoose.isValidObjectId(params.categoryId)) {
    queryParams.categoryId = new mongoose.Types.ObjectId(String(params.categoryId));
  }

  const query = buildProductQuery(queryParams, activeBrands);
  const sort = buildProductSort(params.sortBy);

  const pipeline = [
    { $match: query },
    { $addFields: { effectivePrice: { $ifNull: ['$salePrice', '$basePrice'] } } },
    { $sort: { ...sort, _id: 1 } },
    { $skip: skip },
    { $limit: limit },
  ];

  const [rows, total] = await Promise.all([
    Product.aggregate(pipeline),
    Product.countDocuments(query),
  ]);
  // Re-hydrate so toJSON transforms apply
  const products = rows.map((r) => new Product(r).toJSON());
  return { products, total };
};

const getBrandCategories = async (brandId) => {
  const bId = new mongoose.Types.ObjectId(String(brandId));
  const cats = await Category.find({ brandId: bId, isActive: true }).sort({ createdAt: 1 });
  const counts = await Product.aggregate([
    { $match: { brandId: bId, isActive: true } },
    { $group: { _id: '$categoryId', n: { $sum: 1 } } },
  ]);
  const countMap = {};
  counts.forEach((c) => {
    if (c._id) countMap[String(c._id)] = c.n;
  });
  return buildCategoryTree(cats, countMap);
};

const listOutlets = async (params, { skip, limit }) => {
  const filter = {};
  if (params.brandId) filter.brandId = params.brandId;
  if (params.city) filter['location.city'] = new RegExp(`^${escapeRegex(params.city)}$`, 'i');
  if (!parseBool(params.includeInactive)) filter.isActive = true;

  const lat = parseFloat(params.lat);
  const lng = parseFloat(params.lng);
  if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
    const radiusKm = parseFloat(params.radiusKm) || 25;
    filter.geo = {
      $geoWithin: { $centerSphere: [[lng, lat], radiusKm / 6371] },
    };
  }

  const [outlets, total] = await Promise.all([
    Outlet.find(filter).populate('brandId', 'name primaryColor').sort({ createdAt: -1 }).skip(skip).limit(limit),
    Outlet.countDocuments(filter),
  ]);
  return { outlets, total };
};

module.exports = {
  buildProductQuery,
  buildProductSort,
  buildCategoryTree,
  parseBool,
  escapeRegex,
  listActiveBrands,
  listProducts,
  getBrandCategories,
  listOutlets,
};
