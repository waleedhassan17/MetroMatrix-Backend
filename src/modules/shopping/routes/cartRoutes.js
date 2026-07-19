const express = require('express');
const router = express.Router();
const { protect, userOnly } = require('../../../middleware/authMiddleware');
const {
  getCart,
  addItem,
  updateItem,
  removeItem,
  clearCart,
  applyCoupon,
  removeCoupon,
  listCoupons,
} = require('../controllers/cartController');
const {
  getWishlist,
  addToWishlist,
  removeFromWishlist,
} = require('../controllers/wishlistController');

// All cart/wishlist routes require an authenticated customer.
// Middleware is applied per-route (NOT router.use) because this router is
// mounted at '/', and router.use would also intercept /vendor and /admin
// requests that fall through to later routers.
const customer = [protect, userOnly];

router.get('/cart', customer, getCart);
router.post('/cart/items', customer, addItem);
router.patch('/cart/items/:itemId', customer, updateItem);
router.delete('/cart/items/:itemId', customer, removeItem);
router.delete('/cart', customer, clearCart);
router.post('/cart/coupon', customer, applyCoupon);
router.delete('/cart/coupon', customer, removeCoupon);

router.get('/coupons', customer, listCoupons);

router.get('/wishlist', customer, getWishlist);
router.post('/wishlist/:productId', customer, addToWishlist);
router.delete('/wishlist/:productId', customer, removeFromWishlist);

module.exports = router;
