const mongoose = require('mongoose');

/**
 * Service catalogue (HS5). Replaces the hardcoded electrician/plumber/
 * ac_repairer enum as the source of what customers can search for.
 * `slug` matches the frontend category ids ('electricians', 'plumbers',
 * 'ac-repairers'); `providerSubType` maps to the Provider enum value.
 */
const serviceCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    providerSubType: { type: String, required: true },
    icon: { type: String, default: 'construct-outline' },
    badge: { type: String, default: '' },
    badgeColor: { type: String, default: '#4F46E5' },
    image: { type: String, default: '' },
    description: { type: String, default: '' },
    basePrice: { type: Number, default: 500 },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('HSServiceCategory', serviceCategorySchema);
