const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const MlModelRegistry = require('../models/MlModelRegistry');
const MlJobRun = require('../models/MlJobRun');
const modelStore = require('../services/modelStore');

const ok = (res, data) => res.json({ success: true, data });

const PUBLIC_FIELDS = '-parityFixtures -featureSpec.mean -featureSpec.std';

// GET /api/admin/ml/models?task=provider_matching
const listModels = asyncHandler(async (req, res) => {
  const task = req.query.task ? String(req.query.task) : undefined;
  const rows = await MlModelRegistry.find(task ? { task } : {}).select(PUBLIC_FIELDS).sort({ createdAt: -1 }).limit(30).lean();
  const { getHomeserviceSettings } = require('../../homeservice/services/settingsService');
  const settings = await getHomeserviceSettings();
  ok(res, {
    models: rows,
    serving: { matching: modelStore.status, ranking: settings.ranking },
  });
});

/**
 * POST /api/admin/ml/models/:id/activate  { note? }
 * A model that passed its gates activates as is. One that did not (trained on
 * synthetic data, too little real evidence) may still be activated for a demo
 * — but only with a note, which is stored and shown wherever the model is.
 */
const activateModel = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400);
    throw new Error('Invalid model id');
  }
  const row = await MlModelRegistry.findById(req.params.id);
  if (!row) {
    res.status(404);
    throw new Error('Model not found');
  }
  const note = String((req.body && req.body.note) || '').trim().slice(0, 300);
  const passed = row.gates && row.gates.passed;
  if (!passed && !note) {
    res.status(400);
    throw new Error(
      `This model did not pass its gates (${((row.gates && row.gates.reasons) || []).join('; ') || 'not evaluated'}). Add a note to activate it anyway, e.g. "demo".`
    );
  }
  await MlModelRegistry.updateMany({ task: row.task, status: 'active', _id: { $ne: row._id } }, { $set: { status: 'archived' } });
  row.status = 'active';
  row.activatedBy = req.user._id;
  row.activationNote = passed ? note : `Activated without passing gates: ${note}`;
  await row.save();
  await modelStore.invalidate();
  ok(res, { id: String(row._id), version: row.version, status: row.status, activationNote: row.activationNote });
});

// POST /api/admin/ml/models/:id/archive
const archiveModel = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400);
    throw new Error('Invalid model id');
  }
  const row = await MlModelRegistry.findByIdAndUpdate(req.params.id, { $set: { status: 'archived' } }, { new: true });
  if (!row) {
    res.status(404);
    throw new Error('Model not found');
  }
  await modelStore.invalidate();
  ok(res, { id: String(row._id), status: row.status });
});

// GET /api/admin/ml/runs
const listRuns = asyncHandler(async (req, res) => {
  ok(res, await MlJobRun.find({}).sort({ startedAt: -1 }).limit(30).lean());
});

// POST /api/internal/ml/refresh — the nightly job finished: drop cached models and recommendations.
const refresh = asyncHandler(async (req, res) => {
  await modelStore.invalidate();
  await require('../../../lib/cache').bump('recs');
  ok(res, { refreshed: true });
});

module.exports = { listModels, activateModel, archiveModel, listRuns, refresh };
