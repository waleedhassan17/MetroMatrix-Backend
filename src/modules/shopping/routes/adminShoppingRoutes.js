const express = require('express');
const router = express.Router();
const { protect } = require('../../../middleware/authMiddleware');
const { requireShoppingAdmin } = require('../middleware/adminAuth');
const brandCtrl = require('../controllers/adminBrandController');
const orderCtrl = require('../controllers/adminOrderController');

router.use(protect, requireShoppingAdmin);

// Brand oversight
router.get('/brands', brandCtrl.listBrands);
router.post('/brands', brandCtrl.createBrand);
router.get('/brands/:brandId', brandCtrl.getBrandDetail);
router.patch('/brands/:brandId/status', brandCtrl.setBrandStatus);
router.patch('/brands/:brandId', brandCtrl.updateBrand);
router.delete('/brands/:brandId', brandCtrl.deleteBrand);

// Outlet management (mirrors networks/shopping/outletApi.ts)
router.get('/outlets', brandCtrl.listOutletsAdmin);
router.post('/outlets', brandCtrl.createOutlet);
router.get('/outlets/:outletId', brandCtrl.getOutletAdmin);
router.put('/outlets/:outletId', brandCtrl.updateOutlet);
router.delete('/outlets/:outletId', brandCtrl.deleteOutlet);
router.patch('/outlets/:outletId/assign-brand', brandCtrl.assignBrand);
router.patch('/outlets/:outletId/color-scheme', brandCtrl.updateColorScheme);
router.patch('/outlets/:outletId/toggle-status', brandCtrl.toggleOutletStatus);

// Order oversight
router.get('/orders', orderCtrl.listAllOrders);
router.get('/orders/:orderId', orderCtrl.getOrderDetail);
router.patch('/orders/:orderId/status', orderCtrl.forceOrderStatus);
router.post('/orders/:orderId/refund', orderCtrl.manualRefund);

// Analytics, dashboard, settings
router.get('/analytics', orderCtrl.platformAnalytics);
router.get('/dashboard', orderCtrl.adminDashboard);
router.get('/settings', orderCtrl.getSettings);
router.patch('/settings', orderCtrl.patchSettings);

module.exports = router;
