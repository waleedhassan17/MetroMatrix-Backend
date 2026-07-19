const mongoose = require('mongoose');
const { generateOdexId } = require('../utils/ids');

/**
 * Order — ONE brand's slice of a checkout. Serializes to the frontend
 * Order interface exactly. The customer-facing purchase is the parent
 * OrderGroup; each vendor fulfils their own Order independently.
 */
const orderItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShoppingProduct', required: true },
  brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true },
  variantId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Snapshots at time of purchase — never re-read from the live product
  productName: { type: String, required: true },
  productImage: { type: String, default: '' },
  variantLabel: { type: String, default: '' },
  quantity: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, required: true, min: 0 },
  totalPrice: { type: Number, required: true, min: 0 },
});

orderItemSchema.set('toJSON', {
  versionKey: false,
  transform: (doc, ret) => {
    ret.itemId = String(ret._id);
    ret.productId = String(ret.productId);
    ret.brandId = String(ret.brandId);
    ret.variantId = String(ret.variantId);
    delete ret._id;
    return ret;
  },
});

const shippingAddressSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true },
    phone: { type: String, required: true },
    addressLine1: { type: String, required: true },
    addressLine2: String,
    city: { type: String, required: true },
    state: { type: String, default: '' },
    postalCode: { type: String, default: '' },
    country: { type: String, default: 'Pakistan' },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    odexId: { type: String, unique: true },
    orderGroup: { type: mongoose.Schema.Types.ObjectId, ref: 'ShoppingOrderGroup', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true },
    items: { type: [orderItemSchema], required: true },
    shippingAddress: { type: shippingAddressSchema, required: true },
    paymentMethod: { type: String, enum: ['wallet', 'cod'], required: true },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },
    orderStatus: {
      type: String,
      enum: [
        'pending',
        'confirmed',
        'processing',
        'shipped',
        'out_for_delivery',
        'delivered',
        'cancelled',
        'returned',
        'refunded',
      ],
      default: 'pending',
    },
    trackingNumber: { type: String, default: null },
    subtotal: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    shippingFee: { type: Number, default: 0 },
    total: { type: Number, required: true },
    // Append-only audit of every status change
    statusHistory: [
      {
        status: { type: String, required: true },
        changedBy: {
          id: { type: mongoose.Schema.Types.ObjectId },
          role: { type: String, enum: ['customer', 'vendor', 'admin', 'system'] },
        },
        changedAt: { type: Date, default: Date.now },
        note: String,
      },
    ],
    deliveredAt: { type: Date, default: null },
    // Vendor payout bookkeeping (set when the order reaches delivered)
    vendorPayout: {
      amount: Number,
      commission: Number,
      paidAt: Date,
      walletTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletTransaction' },
    },
  },
  { timestamps: true }
);

orderSchema.index({ brandId: 1, orderStatus: 1 });
orderSchema.index({ userId: 1 });
orderSchema.index({ orderGroup: 1 });
orderSchema.index({ createdAt: -1 });

orderSchema.pre('validate', function (next) {
  if (!this.odexId) this.odexId = generateOdexId('O');
  next();
});

orderSchema.set('toJSON', {
  versionKey: false,
  transform: (doc, ret) => {
    ret.orderId = String(ret._id);
    ret.userId = String(ret.userId);
    ret.brandId =
      ret.brandId && ret.brandId._id ? String(ret.brandId._id) : String(ret.brandId);
    if (doc.populated && doc.populated('brandId') && doc.brandId && doc.brandId.name) {
      ret.brandName = doc.brandId.name;
    }
    ret.orderGroup = ret.orderGroup ? String(ret.orderGroup) : undefined;
    if (ret.trackingNumber === null) delete ret.trackingNumber;
    delete ret._id;
    delete ret.vendorPayout;
    return ret;
  },
});

module.exports = mongoose.model('ShoppingOrder', orderSchema);
