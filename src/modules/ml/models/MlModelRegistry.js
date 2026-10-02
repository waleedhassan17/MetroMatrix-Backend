const mongoose = require('mongoose');

/**
 * Every model the batch jobs train or fit, with honest metrics.
 *
 * `trainedOn.source` says whether a number comes from real platform data or
 * from the simulator — synthetic results are never presented as real
 * accuracy. A model is `active` only after passing its gates (or an admin's
 * explicit, recorded demo activation).
 */
const schema = new mongoose.Schema(
  {
    task: { type: String, required: true }, // demand_forecast | provider_matching | recs_products | recs_doctors | nlq
    version: { type: String, required: true },
    status: { type: String, enum: ['candidate', 'active', 'rejected', 'archived'], default: 'candidate' },
    trainedOn: {
      source: { type: String, enum: ['real', 'synthetic', 'mixed'], default: 'real' },
      nReal: { type: Number, default: 0 },
      nSynthetic: { type: Number, default: 0 },
      from: Date,
      to: Date,
    },
    featureSpec: { type: mongoose.Schema.Types.Mixed, default: null },
    metrics: { type: mongoose.Schema.Types.Mixed, default: {} },
    gates: {
      passed: { type: Boolean, default: false },
      reasons: { type: [String], default: [] },
    },
    artifactId: { type: mongoose.Schema.Types.ObjectId, default: null },
    parityFixtures: { type: mongoose.Schema.Types.Mixed, default: undefined },
    recommendedWeights: { type: mongoose.Schema.Types.Mixed, default: undefined },
    gitSha: String,
    runUrl: String,
    activatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    activationNote: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'ml_model_registry', versionKey: false }
);
schema.index({ task: 1, createdAt: -1 });
schema.index({ task: 1, status: 1 });

module.exports = mongoose.models.MlModelRegistry || mongoose.model('MlModelRegistry', schema);
