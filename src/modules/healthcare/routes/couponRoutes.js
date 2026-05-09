const express = require('express');
const router = express.Router();
const { validateCoupon, createCoupon, getCoupons } = require('../controllers/couponController');
const { requireUser } = require('../middleware/healthcareAuth');

router.post('/validate', requireUser, validateCoupon);
router.post('/', requireUser, createCoupon);
router.get('/', requireUser, getCoupons);

module.exports = router;
