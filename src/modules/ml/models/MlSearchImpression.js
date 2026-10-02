const mongoose = require('mongoose');

/**
 * What one provider search showed, with each candidate's ranking features AS
 * COMPUTED AT SERVE TIME. The matching model trains on these joined with the
 * bookings they led to (hsbookings.rankingContext.searchId), so training sees
 * exactly what serving saw. Ids and numbers only; kept 90 days.
 */
const schema = new mongoose.Schema(
  {
    searchId: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, default: null },
    category: String,
    hasLocation: Boolean,
    sort: String,
    rankingSource: String,
    items: [
      {
        _id: false,
        providerId: mongoose.Schema.Types.ObjectId,
        position: Number,
        heuristicScore: Number,
        modelScore: Number,
        features: mongoose.Schema.Types.Mixed,
      },
    ],
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'ml_search_impressions', versionKey: false }
);
schema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
schema.index({ searchId: 1 }, { unique: true });

module.exports = mongoose.models.MlSearchImpression || mongoose.model('MlSearchImpression', schema);
