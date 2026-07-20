const mongoose = require('mongoose');

const savedAddressSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    label: { type: String, default: 'Home' },
    line1: { type: String, required: true },
    city: { type: String, default: '' },
    icon: {
      type: String,
      enum: ['home', 'building', 'location', 'briefcase'],
      default: 'location',
    },
    isDefault: { type: Boolean, default: false },
    coordinates: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [74.3587, 31.5204] }, // [lng, lat]
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('HSSavedAddress', savedAddressSchema);
