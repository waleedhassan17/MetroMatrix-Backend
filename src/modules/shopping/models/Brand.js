const mongoose = require('mongoose');
const { generateOdexId } = require('../utils/ids');

/**
 * Brand — serializes to the frontend BrandConfig interface.
 * A brand is a profile owned by an approved vendor Provider
 * (admin-created brands may have owner = null until assigned).
 */
const brandSchema = new mongoose.Schema(
  {
    odexId: { type: String, unique: true },
    name: { type: String, required: [true, 'Brand name is required'], trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: String, default: '' },
    tagline: { type: String, default: '' },
    logo: { type: String, default: '' },
    bannerImage: { type: String, default: '' },
    primaryColor: { type: String, default: '#E67E22' },
    secondaryColor: { type: String, default: '#1A1A2E' },
    accentColor: { type: String, default: '#F1C40F' },
    // Display names of the brand's top-level categories (denormalised for cards)
    categories: { type: [String], default: [] },
    policies: {
      returnDays: { type: Number, default: 7 },
      shippingInfo: { type: String, default: 'Delivery within 3-5 working days.' },
      paymentMethods: { type: [String], default: ['wallet', 'cod'] },
    },
    contactEmail: { type: String, default: '' },
    contactPhone: { type: String, default: '' },
    website: { type: String, default: '' },
    socialLinks: {
      facebook: String,
      instagram: String,
      twitter: String,
      tiktok: String,
      youtube: String,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Provider',
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'active', 'suspended'],
      default: 'pending',
      index: true,
    },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    approvedAt: { type: Date, default: null },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

brandSchema.pre('validate', function (next) {
  if (!this.odexId) this.odexId = generateOdexId('B');
  next();
});

brandSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (doc, ret) => {
    ret.brandId = String(ret._id);
    ret.isActive = doc.status === 'active';
    delete ret._id;
    delete ret.isDeleted;
    return ret;
  },
});

module.exports = mongoose.model('Brand', brandSchema);
