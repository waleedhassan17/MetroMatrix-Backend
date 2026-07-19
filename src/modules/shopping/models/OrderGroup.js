const mongoose = require('mongoose');
const { generateOdexId } = require('../utils/ids');

/**
 * OrderGroup — what the customer sees and pays once. One checkout
 * produces one group and N per-brand ShoppingOrder children.
 * The group carries the payment; children carry fulfilment status.
 */
const orderGroupSchema = new mongoose.Schema(
  {
    odexId: { type: String, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    orders: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ShoppingOrder' }],
    shippingAddress: {
      fullName: String,
      phone: String,
      addressLine1: String,
      addressLine2: String,
      city: String,
      state: String,
      postalCode: String,
      country: String,
    },
    paymentMethod: { type: String, enum: ['wallet', 'cod'], required: true },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },
    subtotal: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    shippingFee: { type: Number, default: 0 },
    total: { type: Number, required: true },
    appliedCoupon: { type: String, default: null },
    walletTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WalletTransaction',
      default: null,
    },
  },
  { timestamps: true }
);

orderGroupSchema.index({ userId: 1, createdAt: -1 });

orderGroupSchema.pre('validate', function (next) {
  if (!this.odexId) this.odexId = generateOdexId('G');
  next();
});

orderGroupSchema.set('toJSON', {
  versionKey: false,
  transform: (doc, ret) => {
    ret.groupId = String(ret._id);
    ret.userId = String(ret.userId);
    if (ret.appliedCoupon === null) delete ret.appliedCoupon;
    delete ret._id;
    delete ret.walletTransactionId;
    return ret;
  },
});

module.exports = mongoose.model('ShoppingOrderGroup', orderGroupSchema);
