const mongoose = require('mongoose');

/**
 * Category — serializes to the frontend Category interface.
 * Self-referencing parentId supports a 2-level tree; the tree
 * (children + productCount) is assembled at read time by catalogService.
 */
const categorySchema = new mongoose.Schema(
  {
    brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true },
    name: { type: String, required: [true, 'Category name is required'], trim: true },
    slug: { type: String, required: true, lowercase: true, trim: true },
    icon: { type: String, default: '' },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

categorySchema.index({ brandId: 1, slug: 1 }, { unique: true });

categorySchema.set('toJSON', {
  versionKey: false,
  transform: (doc, ret) => {
    ret.categoryId = String(ret._id);
    ret.brandId = ret.brandId ? String(ret.brandId) : undefined;
    ret.parentId = ret.parentId ? String(ret.parentId) : undefined;
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('ShoppingCategory', categorySchema);
