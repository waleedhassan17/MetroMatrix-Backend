const mongoose = require('mongoose');

/**
 * Cart — one open cart per user. Line items pin product/variant/unitPrice
 * at time-of-add; all totals are recomputed server-side on every mutation
 * (cartService.computeTotals) and never trusted from the client.
 */
const cartItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'ShoppingProduct', required: true },
  brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true },
  variantId: { type: mongoose.Schema.Types.ObjectId, required: true },
  quantity: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, required: true, min: 0 },
});

const cartSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    items: { type: [cartItemSchema], default: [] },
    appliedCoupon: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ShoppingCart', cartSchema);
