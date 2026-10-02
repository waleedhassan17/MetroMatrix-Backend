const mongoose = require('mongoose');
const Brand = require('../models/Brand');
const Category = require('../models/Category');
const Product = require('../models/Product');
const Outlet = require('../models/Outlet');
const ShoppingBanner = require('../models/ShoppingBanner');

/**
 * Pure query builders — exported separately so filter/sort/pagination
 * logic is unit-testable without a database.
 */

// Matches FetchProductsParams in the frontend's networks/shopping/productApi.ts
/** What any customer-facing read requires of a product, besides its brand being active. */
const CUSTOMER_VISIBLE = Object.freeze({
  isActive: true,
  'moderation.status': { $nin: ['pending', 'rejected', 'removed'] },
});

const buildProductQuery = (params = {}, activeBrandIds = null) => {
  const query = { ...CUSTOMER_VISIBLE };

  if (params.brandId) query.brandId = params.brandId;
  else if (activeBrandIds) query.brandId = { $in: activeBrandIds };

  if (params.categoryId) query.categoryId = params.categoryId;
  if (params.gender) query.tags = String(params.gender).trim().toLowerCase();
  if (parseBool(params.isFeatured)) query.isFeatured = true;
  if (parseBool(params.isNewArrival)) query.isNewArrival = true;
  if (parseBool(params.inStock)) query.inStock = true;
  if (params.color) {
    query['variants.color'] = new RegExp(`\\b${escapeRegex(String(params.color).trim())}\\b`, 'i');
  }
  const minRating = Number(params.minRating);
  if (Number.isFinite(minRating) && minRating > 0) query.rating = { $gte: Math.min(minRating, 5) };

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
 * Live-banner filter: active, and inside its optional date window. A null
 * bound means "no bound", and `{ field: null }` also matches documents where
 * the field was never set, so a banner with neither bound is always live.
 */
const buildActiveBannerQuery = (now = new Date()) => ({
  isActive: true,
  $and: [
    { $or: [{ validFrom: null }, { validFrom: { $lte: now } }] },
    { $or: [{ validUntil: null }, { validUntil: { $gte: now } }] },
  ],
});

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
    const categoryId = new mongoose.Types.ObjectId(String(params.categoryId));
    // Categories are a 2-level tree and products hang off leaf categories only,
    // while getBrandCategories rolls child counts up into the parent. Matching
    // the id exactly meant tapping a parent the UI labelled "Men (6)" opened an
    // empty store — so match its children too.
    const children = await Category.find({ parentId: categoryId }).select('_id');
    queryParams.categoryId = children.length
      ? { $in: [categoryId, ...children.map((c) => c._id)] }
      : categoryId;
  }

  // Natural-language search (`q`): understood filters + a weighted text
  // search over what is left. `search` keeps its old substring behaviour.
  let interpreted = null;
  let textTerms = '';
  if (params.q && String(params.q).trim()) {
    const { understand } = require('../../ml/services/queryUnderstanding');
    const { interpreted: raw, source } = await understand(params.q);
    // `ignore=price,color` — the shopper removed those chips: drop what was
    // understood for them and search without.
    const ignored = String(params.ignore || '')
      .split(',')
      .map((f) => f.trim())
      .filter((f) => IGNORABLE[f]);
    const parsed = { ...raw };
    ignored.forEach((f) => IGNORABLE[f].forEach((key) => delete parsed[key]));
    interpreted = { ...parsed, source, ...(ignored.length ? { ignored } : {}) };
    applyInterpretation(queryParams, parsed, params);
    textTerms = parsed.terms || '';
  }

  const run = async (useText) => {
    const query = buildProductQuery(queryParams, activeBrands);
    if (useText) query.$text = { $search: textTerms };
    else if (textTerms) {
      const rx = new RegExp(textTerms.split(/\s+/).map(escapeRegex).join('|'), 'i');
      query.$or = [{ name: rx }, { description: rx }, { tags: rx }];
    }
    const explicitSort = params.sortBy && params.sortBy !== 'relevance';
    const sort = useText && !explicitSort ? { textScore: -1, rating: -1 } : buildProductSort(params.sortBy);
    const pipeline = [
      { $match: query },
      {
        $addFields: {
          effectivePrice: { $ifNull: ['$salePrice', '$basePrice'] },
          ...(useText ? { textScore: { $meta: 'textScore' } } : {}),
        },
      },
      { $sort: { ...sort, _id: 1 } },
      { $skip: skip },
      { $limit: limit },
    ];
    const [rows, total] = await Promise.all([Product.aggregate(pipeline), Product.countDocuments(query)]);
    return { rows, total };
  };

  // Whole-word text search first; when it finds nothing (a partial word, a
  // typo-ish fragment) fall back to substring matching.
  let rows = [];
  let total = 0;
  try {
    ({ rows, total } = await run(Boolean(textTerms)));
  } catch (e) {
    // No text index (e.g. while scripts/sync-indexes.js swaps it for the
    // weighted one): substring matching below still answers.
    if (!textTerms || !/text index required/i.test((e && e.message) || '')) throw e;
  }
  if (textTerms && total === 0) ({ rows, total } = await run(false));
  // Re-hydrate so toJSON transforms apply
  const products = rows.map((r) => new Product(r).toJSON());
  return { products, total, interpreted };
};

/** Chip name → the understood fields it stands for. */
const IGNORABLE = {
  price: ['minPrice', 'maxPrice'],
  color: ['color'],
  gender: ['gender'],
  brand: ['brandId', 'brandName'],
  category: ['category', 'categoryIds'],
};

/** Fold understood filters into the query params; what the caller set explicitly wins. */
const applyInterpretation = (queryParams, parsed, explicit) => {
  if (parsed.maxPrice && explicit.maxPrice === undefined) queryParams.maxPrice = parsed.maxPrice;
  if (parsed.minPrice && explicit.minPrice === undefined) queryParams.minPrice = parsed.minPrice;
  if (parsed.gender && !explicit.gender) queryParams.gender = parsed.gender;
  if (parsed.brandId && !explicit.brandId && mongoose.isValidObjectId(parsed.brandId)) {
    queryParams.brandId = new mongoose.Types.ObjectId(parsed.brandId);
  }
  if (Array.isArray(parsed.categoryIds) && parsed.categoryIds.length && !explicit.categoryId) {
    queryParams.categoryId = { $in: parsed.categoryIds.filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id)) };
  }
  if (parsed.color) queryParams.color = parsed.color;
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

/**
 * Storefront promo banners. A banner pointing at a brand that has since been
 * suspended or deleted is dropped rather than shown — tapping it would land
 * the shopper on a 404.
 */
const listActiveBanners = async (now = new Date()) => {
  const banners = await ShoppingBanner.find(buildActiveBannerQuery(now)).sort({
    sortOrder: 1,
    createdAt: -1,
  });
  if (banners.length === 0) return [];

  const brandIds = banners.filter((b) => b.brandId).map((b) => b.brandId);
  if (brandIds.length === 0) return banners.map((b) => b.toJSON());

  const liveBrands = await Brand.find({
    _id: { $in: brandIds },
    status: 'active',
    isDeleted: false,
  }).select('_id');
  const liveIds = new Set(liveBrands.map((b) => String(b._id)));

  return banners
    .filter((b) => !b.brandId || liveIds.has(String(b.brandId)))
    .map((b) => b.toJSON());
};

const listOutlets = async (params, { skip, limit }) => {
  const filter = {};
  if (params.brandId) filter.brandId = params.brandId;
  if (params.city) filter['location.city'] = new RegExp(`^${escapeRegex(params.city)}$`, 'i');
  if (!parseBool(params.includeInactive)) filter.isActive = true;

  const lat = parseFloat(params.lat);
  const lng = parseFloat(params.lng);
  if (!Number.isNaN(lat) && !Number.isNaN(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    // Nearest first, with the distance — "outlets near you" used to return
    // the ones inside the circle in creation order, with no distance at all.
    const radiusKm = Math.min(parseFloat(params.radiusKm) || 25, 500);
    const [res] = await Outlet.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [lng, lat] },
          distanceField: 'distanceMeters',
          maxDistance: radiusKm * 1000,
          spherical: true,
          query: filter,
        },
      },
      { $facet: { items: [{ $skip: skip }, { $limit: limit }], total: [{ $count: 'count' }] } },
    ]);
    const docs = res.items.map((raw) => Outlet.hydrate(raw));
    await Outlet.populate(docs, { path: 'brandId', select: 'name primaryColor' });
    const outlets = docs.map((doc, i) => ({
      ...doc.toJSON(),
      distanceKm: Math.round((res.items[i].distanceMeters / 1000) * 10) / 10,
    }));
    return { outlets, total: res.total[0] ? res.total[0].count : 0 };
  }

  const [outlets, total] = await Promise.all([
    Outlet.find(filter).populate('brandId', 'name primaryColor').sort({ createdAt: -1 }).skip(skip).limit(limit),
    Outlet.countDocuments(filter),
  ]);
  return { outlets, total };
};

module.exports = {
  CUSTOMER_VISIBLE,
  buildProductQuery,
  buildProductSort,
  buildCategoryTree,
  buildActiveBannerQuery,
  parseBool,
  escapeRegex,
  listActiveBrands,
  listProducts,
  getBrandCategories,
  listActiveBanners,
  listOutlets,
};
