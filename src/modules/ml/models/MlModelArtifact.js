const mongoose = require('mongoose');

/** A trained model's weights, in TensorFlow.js LayersModel form (written by ml/mm_ml). */
const schema = new mongoose.Schema(
  {
    task: { type: String, required: true },
    version: { type: String, required: true },
    format: { type: String, default: 'tfjs-layers' },
    modelTopology: { type: mongoose.Schema.Types.Mixed, required: true },
    weightSpecs: { type: mongoose.Schema.Types.Mixed, required: true },
    weightDataB64: { type: String, required: true },
    sizeBytes: Number,
    sha256: String,
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'ml_model_artifacts', versionKey: false }
);
schema.index({ task: 1, version: 1 }, { unique: true });

module.exports = mongoose.models.MlModelArtifact || mongoose.model('MlModelArtifact', schema);
