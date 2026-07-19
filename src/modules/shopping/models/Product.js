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
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

productSchema.index({ brandId: 1, categoryId: 1 });
productSchema.index({ name: 'text', description: 'text', tags: 'text' });
productSchema.index({ isFeatured: 1 });
productSchema.index({ isNewArrival: 1 });
productSchema.index({ createdAt: -1 });

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
