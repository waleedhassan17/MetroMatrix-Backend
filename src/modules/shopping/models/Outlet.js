const mongoose = require('mongoose');
const { slugify } = require('../utils/ids');

/**
 * Outlet — physical store location, serializes to OutletConfig.
 * Coordinates are stored as a GeoJSON Point (2dsphere) for radius queries
 * and serialized back to location.latitude / location.longitude.
 */
const outletSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Outlet name is required'], trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: String, default: '' },
    brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', default: null, index: true },
    colorScheme: {
      primaryColor: String,
      secondaryColor: String,
      accentColor: String,
      headerBg: String,
      textOnHeader: String,
    },
    location: {
      address: { type: String, default: '' },
      city: { type: String, default: '' },
      state: { type: String, default: '' },
      country: { type: String, default: 'Pakistan' },
      postalCode: { type: String, default: '' },
    },
    geo: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      // [lng, lat]
      coordinates: { type: [Number], default: undefined },
    },
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
    openingHours: { type: String, default: '' },
    managerName: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    images: { type: [String], default: [] },
    floorArea: { type: Number, default: null },
  },
  { timestamps: true }
);

outletSchema.index({ geo: '2dsphere' }, { sparse: true });

outletSchema.pre('validate', function (next) {
  if (!this.slug && this.name) this.slug = slugify(this.name);
  next();
});

outletSchema.set('toJSON', {
  versionKey: false,
  transform: (doc, ret) => {
    ret.outletId = String(ret._id);
    // Populated brand → brandName/brandPrimaryColor extras the FE renders.
    // Read the id off `doc` (raw, un-transformed), not `ret` — Brand's own
    // toJSON runs first on nested docs and renames _id -> brandId there too,
    // so `ret.brandId._id` is always undefined once populated.
    if (doc.populated && doc.populated('brandId') && doc.brandId) {
      ret.brandName = doc.brandId.name;
      ret.brandPrimaryColor = doc.brandId.primaryColor;
      ret.brandId = String(doc.brandId._id);
    } else if (ret.brandId) {
      ret.brandId = String(ret.brandId);
    }
    ret.location = { ...(ret.location || {}) };
    if (doc.geo && Array.isArray(doc.geo.coordinates) && doc.geo.coordinates.length === 2) {
      ret.location.longitude = doc.geo.coordinates[0];
      ret.location.latitude = doc.geo.coordinates[1];
    }
    if (ret.floorArea === null) delete ret.floorArea;
    delete ret.geo;
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('Outlet', outletSchema);
