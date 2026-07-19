const express = require('express');
const router = express.Router();
const { protect } = require('../../../middleware/authMiddleware');
const { requireVendor, requireBrandOwner } = require('../middleware/vendorAuth');
const brandCtrl = require('../controllers/vendorBrandController');
const catalogCtrl = require('../controllers/vendorCatalogController');
const orderCtrl = require('../controllers/vendorOrderController');

router.use(protect, requireVendor);

// Brand self-management — createMyBrand is the only route without a brand yet
router.post('/brand', brandCtrl.createMyBrand);
router.use(requireBrandOwner);
router.get('/brand', brandCtrl.getMyBrand);
router.patch('/brand', brandCtrl.updateMyBrand);
router.post('/brand/logo', brandCtrl.uploadBrandLogo);
router.post('/brand/banner', brandCtrl.uploadBrandBanner);

// Catalogue
router.get('/products', catalogCtrl.getMyProducts);
router.post('/products', catalogCtrl.createProduct);
router.patch('/products/:productId', catalogCtrl.updateProduct);
router.delete('/products/:productId', catalogCtrl.deleteProduct);
router.post('/products/:productId/images', catalogCtrl.addProductImages);

router.get('/categories', catalogCtrl.getMyCategories);
router.post('/categories', catalogCtrl.createCategory);
router.patch('/categories/:categoryId', catalogCtrl.updateCategory);
router.delete('/categories/:categoryId', catalogCtrl.deleteCategory);

// Inventory
router.get('/inventory', catalogCtrl.getInventory);
router.patch('/inventory/:variantId', catalogCtrl.updateStock);
router.post('/inventory/bulk', catalogCtrl.bulkUpdateStock);

// Orders & returns
router.get('/orders', orderCtrl.getBrandOrders);
router.get('/orders/:orderId', orderCtrl.getBrandOrder);
router.patch('/orders/:orderId/status', orderCtrl.updateOrderStatus);
router.get('/returns', orderCtrl.getBrandReturns);
router.patch('/returns/:returnId', orderCtrl.updateReturnRequest);

// Coupons & reviews
router.get('/coupons', brandCtrl.getMyCoupons);
router.post('/coupons', brandCtrl.createCoupon);
router.patch('/coupons/:couponCode', brandCtrl.updateCoupon);
router.get('/reviews', brandCtrl.getMyReviews);
router.post('/reviews/:reviewId/respond', brandCtrl.respondToReview);

// Analytics & dashboard
router.get('/analytics', orderCtrl.getBrandAnalytics);
router.get('/dashboard', orderCtrl.getBrandDashboard);

module.exports = router;
