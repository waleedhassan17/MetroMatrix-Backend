const asyncHandler = require('express-async-handler');
const Brand = require('../models/Brand');
const Category = require('../models/Category');
const Product = require('../models/Product');
const Outlet = require('../models/Outlet');
const catalogService = require('../services/catalogService');
const { ok, paginated, fail, parsePagination } = require('../utils/respond');

const isCastError = (e) =>
  e.name === 'CastError' || e.name === 'BSONError' || e.name === 'BSONTypeError';

// @desc  GET /api/shopping/brands (public, active brands only)
const getBrands = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const { brands, total } = await catalogService.listActiveBrands({ skip, limit });
  return paginated(res, { data: brands, page, limit, total });
});

// @desc  GET /api/shopping/brands/:brandId (public)
const getBrandById = asyncHandler(async (req, res) => {
  try {
    const brand = await Brand.findOne({
      _id: req.params.brandId,
      status: 'active',
      isDeleted: false,
    });
    if (!brand) return fail(res, 404, 'Brand not found');
    return ok(res, brand);
  } catch (e) {
    if (isCastError(e)) return fail(res, 400, 'Invalid brand ID');
    throw e;
  }
});

// @desc  GET /api/shopping/brands/slug/:slug (public)
const getBrandBySlug = asyncHandler(async (req, res) => {
  const brand = await Brand.findOne({
    slug: String(req.params.slug).toLowerCase(),
    status: 'active',
    isDeleted: false,
  });
  if (!brand) return fail(res, 404, 'Brand not found');
  return ok(res, brand);
});

// @desc  GET /api/shopping/brands/:brandId/categories (public)
const getBrandCategories = asyncHandler(async (req, res) => {
  try {
    const brand = await Brand.findOne({
      _id: req.params.brandId,
      status: 'active',
      isDeleted: false,
    });
    if (!brand) return fail(res, 404, 'Brand not found');
    const tree = await catalogService.getBrandCategories(brand._id);
    return ok(res, tree);
  } catch (e) {
    if (isCastError(e)) return fail(res, 400, 'Invalid brand ID');
    throw e;
  }
});

// @desc  GET /api/shopping/categories/:categoryId (public)
const getCategoryById = asyncHandler(async (req, res) => {
  try {
    const category = await Category.findOne({ _id: req.params.categoryId, isActive: true });
    if (!category) return fail(res, 404, 'Category not found');
    const json = category.toJSON();
    json.children = [];
    json.productCount = await Product.countDocuments({
      categoryId: category._id,
      isActive: true,
    });
    return ok(res, json);
  } catch (e) {
    if (isCastError(e)) return fail(res, 400, 'Invalid category ID');
    throw e;
  }
});

// @desc  GET /api/shopping/products (public — FetchProductsParams filter set)
const getProducts = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  try {
    const { products, total } = await catalogService.listProducts(req.query, {
      page,
      limit,
      skip,
    });
    return paginated(res, { data: products, page, limit, total });
  } catch (e) {
    if (isCastError(e)) return fail(res, 400, 'Invalid filter ID');
    throw e;
  }
});

// @desc  GET /api/shopping/products/:productId (public)
const getProductById = asyncHandler(async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.productId, isActive: true });
    if (!product) return fail(res, 404, 'Product not found');
    const brand = await Brand.findOne({
      _id: product.brandId,
      status: 'active',
      isDeleted: false,
    });
    if (!brand) return fail(res, 404, 'Product not found');
    return ok(res, product);
  } catch (e) {
    if (isCastError(e)) return fail(res, 400, 'Invalid product ID');
    throw e;
  }
});

// @desc  GET /api/shopping/outlets (public)
const getOutlets = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  try {
    const { outlets, total } = await catalogService.listOutlets(req.query, { skip, limit });
    return paginated(res, { data: outlets, page, limit, total });
  } catch (e) {
    if (isCastError(e)) return fail(res, 400, 'Invalid filter ID');
    throw e;
  }
});

// @desc  GET /api/shopping/outlets/:outletId (public)
const getOutletById = asyncHandler(async (req, res) => {
  try {
    const outlet = await Outlet.findById(req.params.outletId).populate(
      'brandId',
      'name primaryColor'
    );
    if (!outlet) return fail(res, 404, 'Outlet not found');
    return ok(res, outlet);
  } catch (e) {
    if (isCastError(e)) return fail(res, 400, 'Invalid outlet ID');
    throw e;
  }
});

module.exports = {
  getBrands,
  getBrandById,
  getBrandBySlug,
  getBrandCategories,
  getCategoryById,
  getProducts,
  getProductById,
  getOutlets,
  getOutletById,
};
