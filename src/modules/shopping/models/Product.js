const mongoose = require('mongoose');
const { generateOdexId } = require('../utils/ids');

const variantSchema = new mongoose.Schema({
  size: String,
  color: String,
  colorCode: String,
  additionalPrice: { type: Number, default: 0 },
  stockQuantity: { type: Number, default: 0, min: 0 },
  sku: { type: String, default: '' },
});

variantSchema.set('toJSON', {
  versionKey: false,
  transform: (doc, ret) => {
    ret.variantId = String(ret._id);
    delete ret._id;
    return ret;
  },
});

/**
 * Product — serializes to the frontend Product interface.
 * rating / totalReviews are denormalised (recomputed on review writes).
 * inStock is stored (derived from variants) so it can be filtered in queries.
 */
const productSchema = new mongoose.Schema(
  {
    odexId: { type: String, unique: true },
    brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShoppingCategory', default: null },
    sku: { type: String, default: '' },
    name: { type: String, required: [true, 'Product name is required'], trim: true },
    description: { type: String, default: '' },
    images: { type: [String], default: [] },
    variants: { type: [variantSchema], default: [] },
    basePrice: { type: Number, required: [true, 'Base price is required'], min: 0 },
    salePrice: { type: Number, default: null, min: 0 },
    rating: { type: Number, default: 0 },
    totalReviews: { type: Number, default: 0 },
    isFeatured: { type: Boolean, default: false },
    isNewArrival: { type: Boolean, default: false },
    inStock: { type: Boolean, default: true },
    tags: { type: [String], default: [] },
    // The vendor's own switch: unpublished products stay in their catalogue
    // but no customer sees them. Also what the vendor's "delete" turns off.
    isActive: { type: Boolean, default: true },
    // The platform's switch. A product customers can see must be BOTH
    // published (isActive) and not held by moderation. Absent on products
    // created before moderation existed, which therefore count as approved.
    moderation: {
      status: { type: String, enum: ['approved', 'pending', 'rejected', 'removed'], default: 'approved' },
      note: { type: String, default: '' },
      by: { type: mongoose.Schema.Types.ObjectId, default: null },
      at: { type: Date, default: null },
    },
    // "View in your room": a binary glTF (.glb) for Android's Scene Viewer,
    // optionally a USDZ for iPhone's AR Quick Look. Set only through
    // PATCH /vendor/products/:id/model3d, which checks the files.
    model3d: {
      glbUrl: { type: String, default: null },
      usdzUrl: { type: String, default: null },
      sizeBytes: { type: Number, default: null },
      attachedAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

productSchema.index({ brandId: 1, categoryId: 1 });
// Weighted for natural-language search: a word in the name counts ten times one
// in the description. MongoDB allows ONE text index per collection, so the old
// unweighted one is dropped by scripts/sync-indexes.js (SUPERSEDED).
productSchema.index(
  { name: 'text', tags: 'text', description: 'text' },
  { name: 'product_text_v2', weights: { name: 10, tags: 5, description: 1 }, default_language: 'english' }
);
productSchema.index({ isFeatured: 1 });
productSchema.index({ isNewArrival: 1 });
productSchema.index({ createdAt: -1 });
productSchema.index({ 'moderation.status': 1, createdAt: -1 });

productSchema.methods.syncStockFlag = function () {
  this.inStock = this.variants.some((v) => v.stockQuantity > 0);
};

productSchema.pre('validate', function (next) {
  if (!this.odexId) this.odexId = generateOdexId('P');
  next();
});

productSchema.pre('save', function (next) {
  if (this.isModified('variants')) this.syncStockFlag();
  next();
});

productSchema.set('toJSON', {
  versionKey: false,
  transform: (doc, ret) => {
    ret.productId = String(ret._id);
    ret.brandId = ret.brandId ? String(ret.brandId._id || ret.brandId) : ret.brandId;
    ret.categoryId = ret.categoryId ? String(ret.categoryId._id || ret.categoryId) : '';
    if (ret.salePrice === null) delete ret.salePrice;
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('ShoppingProduct', productSchema);
