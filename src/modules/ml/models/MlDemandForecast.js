const mongoose = require('mongoose');

/**
 * Demand forecasts — written nightly by ml/mm_ml/jobs/forecast_demand.py,
 * read by the admin analytics screens and the provider/doctor/vendor
 * dashboards. One row per (vertical, segment, date, version).
 */
const schema = new mongoose.Schema(
  {
    vertical: { type: String, enum: ['homeservice', 'healthcare', 'shopping'], required: true },
    // 'all', or a category / specialty / brand key
    segment: { type: String, required: true },
    segmentLabel: { type: String, default: '' },
    date: { type: String, required: true }, // YYYY-MM-DD, Pakistan time
    yhat: { type: Number, required: true },
    lo: { type: Number, default: null },
    hi: { type: Number, default: null },
    method: { type: String, default: '' }, // holt_winters | seasonal_naive | mean
    version: { type: String, required: true },
    generatedAt: { type: Date, default: Date.now },
  },
  { collection: 'ml_demand_forecasts', versionKey: false }
);
schema.index({ vertical: 1, segment: 1, date: 1, version: 1 }, { unique: true });
schema.index({ vertical: 1, segment: 1, generatedAt: -1 });

module.exports = mongoose.models.MlDemandForecast || mongoose.model('MlDemandForecast', schema);
