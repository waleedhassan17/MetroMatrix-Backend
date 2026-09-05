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
router.get('/products', getProducts);
router.get('/products/:productId', getProductById);
router.get('/outlets', getOutlets);
router.get('/outlets/:outletId', getOutletById);

module.exports = router;
