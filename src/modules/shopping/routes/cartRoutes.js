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

// All cart/wishlist routes require an authenticated customer
router.use(protect, userOnly);

router.get('/cart', getCart);
router.post('/cart/items', addItem);
router.patch('/cart/items/:itemId', updateItem);
router.delete('/cart/items/:itemId', removeItem);
router.delete('/cart', clearCart);
router.post('/cart/coupon', applyCoupon);
router.delete('/cart/coupon', removeCoupon);

router.get('/coupons', listCoupons);

router.get('/wishlist', getWishlist);
router.post('/wishlist/:productId', addToWishlist);
router.delete('/wishlist/:productId', removeFromWishlist);

module.exports = router;
