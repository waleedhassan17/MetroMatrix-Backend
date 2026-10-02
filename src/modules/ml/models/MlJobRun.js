const mongoose = require('mongoose');

/** One row per batch job execution (ml/ jobs write these in try/finally). */
const schema = new mongoose.Schema(
  {
    job: { type: String, required: true },
    startedAt: { type: Date, required: true },
    finishedAt: Date,
    status: { type: String, enum: ['running', 'ok', 'failed', 'skipped'], default: 'running' },
    rows: { type: Number, default: 0 },
    error: { type: String, default: '' },
    runUrl: String,
    gitSha: String,
  },
  { collection: 'ml_job_runs', versionKey: false }
);
schema.index({ job: 1, startedAt: -1 });

module.exports = mongoose.models.MlJobRun || mongoose.model('MlJobRun', schema);
