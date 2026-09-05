const mongoose = require('mongoose');

/**
 * ShoppingBanner — the promo carousel on the storefront home and brand list.
 *
 * These used to be a hardcoded fixture in the app (networks/shopping/dummyData.ts),
 * which meant marketing copy could only change with an app release and the
 * banners pointed at a brand id that did not exist. They are rows now.
 *
 * A banner may deep-link to a brand or a product, or neither (decoration only).
 * `validFrom`/`validUntil` are optional: a null bound means "no bound", so a
 * banner with neither is simply always live while isActive.
 */
const shoppingBannerSchema = new mongoose.Schema(
  {
    title: { type: String, required: [true, 'Banner title is required'], trim: true },
    subtitle: { type: String, default: '' },
    image: { type: String, required: [true, 'Banner image is required'] },
    brandId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Brand',
      default: null,
      index: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ShoppingProduct',
      default: null,
    },
    // Lower sorts first; ties fall back to newest-first in the query.
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true, index: true },
    validFrom: { type: Date, default: null },
    validUntil: { type: Date, default: null },
  },
  { timestamps: true }
);

shoppingBannerSchema.set('toJSON', {
  versionKey: false,
  transform: (doc, ret) => {
    ret.bannerId = String(ret._id);
    // A populated brandId would otherwise serialize as a nested document and
    // break the client's `brandId` string contract.
    if (ret.brandId) ret.brandId = String(ret.brandId._id || ret.brandId);
    if (ret.productId) ret.productId = String(ret.productId._id || ret.productId);
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('ShoppingBanner', shoppingBannerSchema);
