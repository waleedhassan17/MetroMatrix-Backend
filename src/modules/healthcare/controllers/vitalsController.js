const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const HealthVital = require('../models/HealthVital');
const { normaliseReading, MAX_BATCH } = require('../services/vitalsService');

const TYPES = ['heart_rate', 'blood_pressure'];

async function listFor(patientId, query) {
  const filter = { patientId };
  if (query.type) {
    if (!TYPES.includes(query.type)) {
      const err = new Error('type must be heart_rate or blood_pressure');
      err.statusCode = 400;
      throw err;
    }
    filter.type = query.type;
  }
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
  const [items, latestHr, latestBp] = await Promise.all([
    HealthVital.find(filter).sort({ measuredAt: -1 }).limit(limit),
    HealthVital.findOne({ patientId, type: 'heart_rate' }).sort({ measuredAt: -1 }),
    HealthVital.findOne({ patientId, type: 'blood_pressure' }).sort({ measuredAt: -1 }),
  ]);
  return { items, latest: { heartRate: latestHr, bloodPressure: latestBp } };
}

// GET /api/v1/healthcare/vitals?type=&limit=    — the patient's own readings
const getMyVitals = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await listFor(req.user._id, req.query) });
});

// POST /api/v1/healthcare/vitals   { readings: [...] }  (up to 50)
// Each reading is checked on its own: good ones are saved, bad ones come back
// with a reason, a reading already saved (same clientId) is not duplicated.
const addVitals = asyncHandler(async (req, res) => {
  const readings = Array.isArray(req.body && req.body.readings) ? req.body.readings : [req.body].filter(Boolean);
  if (!readings.length) {
    res.status(400);
    throw new Error('readings are required');
  }
  if (readings.length > MAX_BATCH) {
    res.status(400);
    throw new Error(`At most ${MAX_BATCH} readings at a time`);
  }
  const rejected = [];
  const docs = [];
  readings.forEach((r, index) => {
    const { doc, error } = normaliseReading(r);
    if (error) rejected.push({ index, error });
    else docs.push({ ...doc, patientId: req.user._id });
  });
  let saved = [];
  let duplicates = 0;
  if (docs.length) {
    try {
      saved = await HealthVital.insertMany(docs, { ordered: false });
    } catch (e) {
      if (!e || !Array.isArray(e.writeErrors)) throw e;
      if (e.writeErrors.some((w) => w.code !== 11000 && (w.err ? w.err.code : w.code) !== 11000)) throw e;
      duplicates = e.writeErrors.length;
      saved = e.insertedDocs || [];
    }
  }
  res.status(docs.length ? 201 : 400).json({
    success: docs.length > 0,
    data: { saved: saved.map((s) => (s.toJSON ? s.toJSON() : s)), duplicates, rejected },
    ...(docs.length ? {} : { error: rejected[0] ? rejected[0].error : 'No valid readings' }),
  });
});

// DELETE /api/v1/healthcare/vitals/:id   — own readings only
const deleteVital = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400);
    throw new Error('Invalid id');
  }
  const r = await HealthVital.deleteOne({ _id: req.params.id, patientId: req.user._id });
  if (!r.deletedCount) {
    res.status(404);
    throw new Error('Reading not found');
  }
  res.json({ success: true });
});

// GET /api/v1/healthcare/doctors/me/patients/:patientId/vitals
// (requireTreatingDoctor: only a doctor this patient has booked)
const getPatientVitals = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.patientId)) {
    res.status(400);
    throw new Error('Invalid patient id');
  }
  res.json({ success: true, data: await listFor(req.params.patientId, req.query) });
});

module.exports = { getMyVitals, addVitals, deleteVital, getPatientVitals };
