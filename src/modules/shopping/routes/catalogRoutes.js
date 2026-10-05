const express = require('express');
const router = express.Router();
const {
  getBrands,
  getBrandById,
  getBrandBySlug,
  getBrandCategories,
  getCategoryById,
  getProducts,
  getProductById,
  getOutlets,
  getOutletById,
  getBanners,
} = require('../controllers/catalogController');

// Public browsing — no auth required
router.get('/banners', getBanners);
router.get('/brands', getBrands);
router.get('/brands/slug/:slug', getBrandBySlug);
router.get('/brands/:brandId/categories', getBrandCategories);
router.get('/brands/:brandId', getBrandById);
router.get('/categories/:categoryId', getCategoryById);
// A natural-language query (`q`) may call the LLM: it gets its own, tighter budget.
const nlqBudget = (req, res, next) =>
  req.query && req.query.q ? require('../../../gateway/rateLimit').limiter('nlq')(req, res, next) : next();
router.get('/products', nlqBudget, getProducts);
router.get('/products/:productId', getProductById);
router.get('/outlets', getOutlets);
router.get('/outlets/:outletId', getOutletById);

module.exports = router;
