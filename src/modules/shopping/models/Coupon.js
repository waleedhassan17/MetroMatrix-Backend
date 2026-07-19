const mongoose = require('mongoose');

/**
 * Coupon — serializes to the frontend Coupon interface.
 * brandId null = platform-wide coupon; set = discounts only that brand's lines.
 */
const couponSchema = new mongoose.Schema(
  {
    couponCode: {
      type: String,
      required: [true, 'Coupon code is required'],
      unique: true,
      uppercase: true,
      trim: true,
    },
    brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', default: null },
    type: { type: String, enum: ['percentage', 'fixed'], required: true },
    value: { type: Number, required: true, min: 0 },
    minOrderAmount: { type: Number, default: 0 },
    maxDiscount: { type: Number, default: 0 }, // 0 = no cap (fixed coupons)
    validFrom: { type: Date, required: true },
    validUntil: { type: Date, required: true },
    usageLimit: { type: Number, default: 0 }, // 0 = unlimited
    usedCount: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    createdBy: {
      id: { type: mongoose.Schema.Types.ObjectId },
      role: { type: String, enum: ['admin', 'vendor'] },
    },
  },
  { timestamps: true }
);

couponSchema.set('toJSON', {
  versionKey: false,
  transform: (doc, ret) => {
    ret.brandId = ret.brandId ? String(ret.brandId) : undefined;
    delete ret._id;
    delete ret.createdBy;
    return ret;
  },
});

module.exports = mongoose.model('ShoppingCoupon', couponSchema);
