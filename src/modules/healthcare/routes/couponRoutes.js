const express = require('express');
const router = express.Router();
const { validateCoupon, createCoupon, getCoupons } = require('../controllers/couponController');
const { requireUser, requireAdmin } = require('../middleware/healthcareAuth');

router.post('/validate', requireUser, validateCoupon);
// Coupon creation and full listing are admin operations — previously any
// authenticated patient could create coupons (SECURITY_FIXES.md #2).
router.post('/', requireAdmin, createCoupon);
router.get('/', requireAdmin, getCoupons);

module.exports = router;
