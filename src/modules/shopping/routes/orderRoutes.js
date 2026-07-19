const express = require('express');
const router = express.Router();
const { protect, userOnly } = require('../../../middleware/authMiddleware');
const {
  postCheckout,
  getMyOrders,
  getOrderById,
  getOrderTracking,
  cancelOrder,
  requestReturn,
  getMyReturns,
} = require('../controllers/orderController');
const {
  getAddresses,
  createAddress,
  updateAddress,
  deleteAddress,
} = require('../controllers/addressController');
const { getProductReviews, submitProductReview } = require('../controllers/reviewController');

// Public review reads
router.get('/products/:productId/reviews', getProductReviews);

// Authenticated customer routes
router.post('/checkout', protect, userOnly, postCheckout);
router.get('/orders', protect, userOnly, getMyOrders);
router.get('/orders/:orderId/tracking', protect, userOnly, getOrderTracking);
router.post('/orders/:orderId/cancel', protect, userOnly, cancelOrder);
router.post('/orders/:orderId/return', protect, userOnly, requestReturn);
router.get('/orders/:id', protect, userOnly, getOrderById);
router.get('/returns', protect, userOnly, getMyReturns);

router.get('/addresses', protect, userOnly, getAddresses);
router.post('/addresses', protect, userOnly, createAddress);
router.patch('/addresses/:addressId', protect, userOnly, updateAddress);
router.delete('/addresses/:addressId', protect, userOnly, deleteAddress);

router.post('/products/:productId/review', protect, userOnly, submitProductReview);

module.exports = router;
