const mongoose = require('mongoose');

/**
 * HealthcareBanner — the promotions on the patient's Health home.
 *
 * Staff choose them (admin /api/v1/admin/healthcare/banners), the same way
 * ShoppingBanner drives the storefront. A banner leads somewhere: a specialty
 * (that specialty's doctors), a doctor (the profile), one of the app's own
 * screens, or nowhere (decoration only).
 *
 * `city` scopes a banner to one city's patients (null: every city).
 * `validFrom`/`validUntil` are optional: a null bound means "no bound".
 * `seedKey` marks the rows scripts/seed-healthcare-home.js owns, so a re-run
 * updates them instead of adding copies; staff-made banners leave it null.
 */
const TARGET_TYPES = ['specialty', 'doctor', 'screen', 'none'];
const TARGET_SCREENS = ['video_consultation', 'available_today', 'symptom_checker', 'emergency', 'records'];

const healthcareBannerSchema = new mongoose.Schema(
  {
    title: { type: String, required: [true, 'Banner title is required'], trim: true, maxlength: 80 },
    subtitle: { type: String, default: '', trim: true, maxlength: 160 },
    image: { type: String, required: [true, 'Banner image is required'] },
    targetType: { type: String, enum: TARGET_TYPES, default: 'none' },
    targetScreen: { type: String, enum: [...TARGET_SCREENS, null], default: null },
    specialtyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Specialty', default: null },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', default: null },
    city: { type: String, default: null, trim: true },
    // Lower sorts first; ties fall back to newest-first in the query.
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    validFrom: { type: Date, default: null },
    validUntil: { type: Date, default: null },
    seedKey: { type: String, default: null },
  },
  { timestamps: true }
);

healthcareBannerSchema.index({ isActive: 1, sortOrder: 1 });
healthcareBannerSchema.index({ seedKey: 1 }, { unique: true, partialFilterExpression: { seedKey: { $type: 'string' } } });

healthcareBannerSchema.set('toJSON', {
  versionKey: false,
  transform(doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    return ret;
  },
});

const HealthcareBanner = mongoose.model('HealthcareBanner', healthcareBannerSchema);
HealthcareBanner.TARGET_TYPES = TARGET_TYPES;
HealthcareBanner.TARGET_SCREENS = TARGET_SCREENS;

module.exports = HealthcareBanner;
