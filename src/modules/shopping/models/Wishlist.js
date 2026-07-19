const mongoose = require('mongoose');

const wishlistSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    items: [
      {
        product: { type: mongoose.Schema.Types.ObjectId, ref: 'ShoppingProduct', required: true },
        brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true },
        addedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model('ShoppingWishlist', wishlistSchema);
