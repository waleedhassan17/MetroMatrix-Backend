const Coupon = require('../models/Coupon');

/**
 * Validate a coupon code against a given amount.
 * @param {string} code - Coupon code (case-insensitive)
 * @param {number} amount - The base fee amount to apply the coupon against
 * @returns {{ valid, error?, coupon?, discountAmount?, finalAmount? }}
 */
const validateCoupon = async (code, amount) => {
  const coupon = await Coupon.findOne({
    code: code.toUpperCase(),
    isActive: true,
  });

  if (!coupon) {
    return { valid: false, error: 'Invalid coupon code' };
  }

  const now = new Date();

  // Date range check
  if (now < coupon.validFrom) {
    return { valid: false, error: 'Coupon is not yet active' };
  }
  if (now > coupon.validUntil) {
    return { valid: false, error: 'Coupon has expired' };
  }

  // Usage limit check
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
    return { valid: false, error: 'Coupon usage limit has been reached' };
  }

  // Minimum amount check
  if (coupon.minAmount !== null && amount < coupon.minAmount) {
    return {
      valid: false,
      error: `Minimum order amount of ${coupon.minAmount} is required for this coupon`,
    };
  }

  // Calculate discount
  let discountAmount;
  if (coupon.type === 'percentage') {
    discountAmount = (coupon.value / 100) * amount;
    // Cap at maxDiscount if set
    if (coupon.maxDiscount !== null && discountAmount > coupon.maxDiscount) {
      discountAmount = coupon.maxDiscount;
    }
  } else {
    // fixed
    discountAmount = coupon.value;
  }

  // Round to 2 decimal places
  discountAmount = Math.round(discountAmount * 100) / 100;
  const finalAmount = Math.max(0, Math.round((amount - discountAmount) * 100) / 100);

  return {
    valid: true,
    coupon: {
      id: coupon._id,
      code: coupon.code,
      type: coupon.type,
      value: coupon.value,
    },
    discountAmount,
    finalAmount,
  };
};

/**
 * Increment usage count after successful booking.
 * @param {string} couponId
 * @param {Object} session - Mongoose session (optional)
 */
const incrementUsage = async (couponId, session = null) => {
  const opts = session ? { session } : {};
  return Coupon.findByIdAndUpdate(
    couponId,
    { $inc: { usedCount: 1 } },
    { new: true, ...opts }
  );
};

/**
 * Create a new coupon (admin).
 */
const createCoupon = async (data) => {
  return Coupon.create(data);
};

/**
 * Get all coupons (admin).
 */
const getAllCoupons = async () => {
  return Coupon.find().sort({ createdAt: -1 });
};

module.exports = { validateCoupon, incrementUsage, createCoupon, getAllCoupons };
