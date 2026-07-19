const mongoose = require('mongoose');

/**
 * Address — saved customer shipping addresses (ShippingAddress + isDefault).
 */
const addressSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    label: { type: String, default: 'Home' },
    fullName: { type: String, required: [true, 'Full name is required'] },
    phone: { type: String, required: [true, 'Phone is required'] },
    addressLine1: { type: String, required: [true, 'Address line 1 is required'] },
    addressLine2: String,
    city: { type: String, required: [true, 'City is required'] },
    state: { type: String, default: '' },
    postalCode: { type: String, default: '' },
    country: { type: String, default: 'Pakistan' },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

addressSchema.set('toJSON', {
  versionKey: false,
  transform: (doc, ret) => {
    ret.addressId = String(ret._id);
    ret.userId = String(ret.userId);
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('ShoppingAddress', addressSchema);
