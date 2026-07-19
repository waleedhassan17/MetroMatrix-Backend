const mongoose = require('mongoose');

/**
 * InventoryLog — append-only trail of every manual stock adjustment.
 */
const inventoryLogSchema = new mongoose.Schema(
  {
    brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'ShoppingProduct', required: true },
    variantId: { type: mongoose.Schema.Types.ObjectId, required: true },
    delta: { type: Number, required: true },
    newQuantity: { type: Number, required: true },
    reason: { type: String, default: '' },
    actor: {
      id: { type: mongoose.Schema.Types.ObjectId },
      role: { type: String, enum: ['vendor', 'admin', 'system'] },
    },
  },
  { timestamps: { createdAt: 'at', updatedAt: false } }
);

inventoryLogSchema.index({ at: -1 });

module.exports = mongoose.model('ShoppingInventoryLog', inventoryLogSchema);
