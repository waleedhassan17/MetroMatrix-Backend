const mongoose = require('mongoose');

/**
 * ReturnRequest — customer-initiated return for (part of) a delivered order.
 * Window enforced against the brand's policies.returnDays from deliveredAt.
 */
const returnRequestSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'ShoppingOrder', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },
    items: [
      {
        orderItemId: { type: mongoose.Schema.Types.ObjectId, required: true },
        productId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShoppingProduct' },
        productName: String,
        variantId: mongoose.Schema.Types.ObjectId,
        quantity: { type: Number, min: 1 },
        unitPrice: Number,
      },
    ],
    reason: { type: String, required: [true, 'Return reason is required'] },
    images: { type: [String], default: [] },
    status: {
      type: String,
      enum: ['requested', 'approved', 'rejected', 'picked_up', 'refunded'],
      default: 'requested',
    },
    vendorNote: { type: String, default: '' },
    refundAmount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

returnRequestSchema.set('toJSON', {
  versionKey: false,
  transform: (doc, ret) => {
    ret.returnId = String(ret._id);
    ret.order = ret.order && ret.order._id ? undefined : String(ret.order);
    if (ret.order === undefined) delete ret.order;
    ret.orderId = doc.order && doc.order._id ? String(doc.order._id) : String(doc.order);
    ret.userId = ret.userId && ret.userId._id ? String(ret.userId._id) : String(ret.userId);
    // Read off `doc`, not `ret` — if brandId is ever populated, Brand's own
    // toJSON transform runs first and renames _id -> brandId on the nested
    // object, so `ret.brandId._id` would always be undefined (see the same
    // bug fixed in Order.js/Outlet.js).
    ret.brandId =
      doc.populated && doc.populated('brandId') && doc.brandId
        ? String(doc.brandId._id)
        : ret.brandId
          ? String(ret.brandId)
          : ret.brandId;
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('ShoppingReturnRequest', returnRequestSchema);
