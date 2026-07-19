const mongoose = require('mongoose');

/**
 * ProductReview — one review per product per order; only for delivered
 * orders containing the product (isVerifiedPurchase always true here).
 */
const productReviewSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ShoppingProduct',
      required: true,
      index: true,
    },
    brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'ShoppingOrder', required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    title: String,
    comment: { type: String, required: [true, 'Review comment is required'] },
    images: { type: [String], default: [] },
    isVerifiedPurchase: { type: Boolean, default: true },
    vendorResponse: { type: String, default: '' },
  },
  { timestamps: true }
);

productReviewSchema.index({ productId: 1, userId: 1, order: 1 }, { unique: true });

productReviewSchema.set('toJSON', {
  versionKey: false,
  transform: (doc, ret) => {
    ret.reviewId = String(ret._id);
    ret.productId = String(ret.productId);
    ret.brandId = ret.brandId ? String(ret.brandId) : undefined;
    // Populated user → userName/userAvatar for the reviews screen
    if (ret.userId && typeof ret.userId === 'object') {
      ret.userName = ret.userId.name || ret.userId.fullName || 'Customer';
      ret.userAvatar = ret.userId.profilePicture || ret.userId.avatar || undefined;
      ret.userId = String(ret.userId._id);
    } else if (ret.userId) {
      ret.userId = String(ret.userId);
    }
    delete ret._id;
    delete ret.order;
    return ret;
  },
});

module.exports = mongoose.model('ShoppingProductReview', productReviewSchema);
