const couponService = require('../services/couponService');

// @desc    Validate coupon code
// @route   POST /api/v1/healthcare/coupons/validate
// @access  Private
const validateCoupon = async (req, res, next) => {
  try {
    const { code, amount, doctorId } = req.body;

    if (!code || !code.trim()) {
      return res.status(400).json({ success: false, error: 'Coupon code is required' });
    }
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, error: 'A valid amount is required' });
    }

    const result = await couponService.validateCoupon(code.trim(), Number(amount));

    if (!result.valid) {
      return res.status(400).json({ success: false, error: result.error });
    }

    res.json({
      success: true,
      data: {
        valid: true,
        coupon: result.coupon,
        discountAmount: result.discountAmount,
        finalAmount: result.finalAmount,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create coupon (Admin)
// @route   POST /api/v1/healthcare/coupons
// @access  Private/Admin
const createCoupon = async (req, res, next) => {
  try {
    const coupon = await couponService.createCoupon(req.body);
    res.status(201).json({ success: true, data: coupon });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, error: 'Coupon code already exists' });
    }
    next(error);
  }
};

// @desc    Get all coupons (Admin)
// @route   GET /api/v1/healthcare/coupons
// @access  Private/Admin
const getCoupons = async (req, res, next) => {
  try {
    const coupons = await couponService.getAllCoupons();
    res.json({ success: true, count: coupons.length, data: coupons });
  } catch (error) {
    next(error);
  }
};

module.exports = { validateCoupon, createCoupon, getCoupons };
