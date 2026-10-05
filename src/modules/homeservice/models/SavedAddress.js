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
    // [lng, lat]. [0, 0] means "not located" — the same placeholder bookings
    // use, so copying an address into a booking never trips the 2dsphere
    // index. This used to default to Lahore centre, which made every customer
    // who never pinned an address search "near" the city centre.
    coordinates: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] },
    },
    // How the point was obtained: phone GPS, a pin dropped on the map, or the
    // typed address geocoded on the phone. null = not located.
    coordinatesSource: {
      type: String,
      enum: ['gps', 'pin', 'geocode', null],
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('HSSavedAddress', savedAddressSchema);
