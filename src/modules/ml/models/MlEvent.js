const mongoose = require('mongoose');

/**
 * Interaction log — the raw material for recommendations and for training the
 * provider-matching model (ml/ in this repo reads it nightly).
 *
 * Written by the app through POST /api/events (batched, best-effort) and by
 * the server itself at the moments that matter most (a booking created, an
 * order placed, an appointment booked) so training data does not depend on a
 * client remembering to report it.
 *
 * Kept 180 days. Holds ids and short query strings only — no names, phone
 * numbers or addresses.
 */
const MODULES = ['shopping', 'homeservice', 'healthcare'];
const TYPES = [
  'impression', // a card was shown (with position, and features for ranking)
  'view', // a detail page was opened
  'click', // a card in a list was tapped
  'search', // a query was submitted
  'add_to_cart',
  'wishlist',
  'book', // home-service booking created
  'order', // shopping order placed
  'appointment', // healthcare appointment booked
];

const mlEventSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, default: null },
    role: { type: String, enum: ['user', 'provider', 'admin', null], default: null },
    module: { type: String, enum: MODULES, required: true },
    type: { type: String, enum: TYPES, required: true },
    refId: { type: String, maxlength: 64, default: null },
    query: { type: String, maxlength: 120, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: undefined },
    features: { type: mongoose.Schema.Types.Mixed, default: undefined },
    source: { type: String, enum: ['app', 'server'], default: 'app' },
    ts: { type: Date, default: Date.now },
  },
  { collection: 'ml_events', versionKey: false }
);

mlEventSchema.index({ ts: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });
mlEventSchema.index({ userId: 1, module: 1, ts: -1 });
mlEventSchema.index({ module: 1, type: 1, ts: -1 });

module.exports = mongoose.models.MlEvent || mongoose.model('MlEvent', mlEventSchema);
module.exports.MODULES = MODULES;
module.exports.TYPES = TYPES;
