const mongoose = require('mongoose');

/**
 * Batch recommendation outputs (written nightly by ml/mm_ml/jobs/recommend.py).
 * Loose schemas: the Python job owns their shape; the API only reads them.
 */
const userRecs = new mongoose.Schema(
  {
    userId: String,
    domain: { type: String, enum: ['shopping', 'healthcare', 'homeservice'] },
    items: [{ _id: false, id: String, score: Number, reason: String }],
    version: String,
    generatedAt: Date,
    expiresAt: Date,
  },
  { collection: 'ml_user_recs', versionKey: false }
);
userRecs.index({ userId: 1, domain: 1 });
userRecs.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const itemSims = new mongoose.Schema(
  {
    domain: String,
    itemId: String,
    neighbors: [{ _id: false, id: String, score: Number, reason: String }],
    version: String,
    generatedAt: Date,
  },
  { collection: 'ml_item_similarities', versionKey: false }
);
itemSims.index({ domain: 1, itemId: 1 });

const popularSchema = new mongoose.Schema(
  {
    domain: String,
    segment: String,
    items: [{ _id: false, id: String, score: Number, reason: String }],
    version: String,
    generatedAt: Date,
  },
  { collection: 'ml_popular', versionKey: false }
);
popularSchema.index({ domain: 1, segment: 1 });

module.exports = {
  MlUserRecs: mongoose.models.MlUserRecs || mongoose.model('MlUserRecs', userRecs),
  MlItemSimilarity: mongoose.models.MlItemSimilarity || mongoose.model('MlItemSimilarity', itemSims),
  MlPopular: mongoose.models.MlPopular || mongoose.model('MlPopular', popularSchema),
};
