const Slot = require('../models/Slot');
const Clinic = require('../models/Clinic');
const Doctor = require('../models/Doctor');
const { expandDay } = require('./availabilityService');
const { todayKey, addDays, eachDay, weekdayName, toDateKey, DEFAULT_TIMEZONE } = require('../../../utils/time');

// ============================================================================
// Turning a weekly template into actual bookable slots — and KEEPING it turned.
//
// WHY THE ROLLING HORIZON EXISTS
// ------------------------------
// Generation was one-shot. The doctor app published a fixed window (30 days)
// and nothing ever extended it. So a doctor set their availability once, and
// roughly a month later it silently ran out: no error, no warning to the
// doctor, no signal to patients — just a calendar that quietly stopped having
// anything in it.
//
// That is not hypothetical. At the time this was written, ALL 530 slots in
// production ran 2026-07-08 to 2026-08-27 and the date was 2026-08-29, so
// every one of the thirteen doctors had exactly zero bookable slots and no
// patient could book anything at all. Fixing generation without fixing the
// horizon would have reproduced that same state a month later.
//
// So generation is idempotent and re-runnable, and a scheduled job tops every
// active doctor back up to HORIZON_DAYS. The doctor-facing warning banner is
// the second line of defence, not the first — the system should not depend on
// a doctor noticing.
// ============================================================================

/** How far ahead availability is kept populated. */
const HORIZON_DAYS = Number(process.env.SLOT_HORIZON_DAYS || 60);

/** Default consultation length when the doctor has not chosen one. */
const DEFAULT_SLOT_MINUTES = Number(process.env.DEFAULT_SLOT_MINUTES || 30);

/**
 * Generate slots for one doctor across a date range.
 *
 * Idempotent: a slot is identified by (clinic, instant, type), so re-running
 * over a range that is already populated inserts nothing. That is what makes it
 * safe to run from a cron job every day.
 *
 * @returns {{created:number, candidates:number, skipped:number, through:string|null}}
 */
async function generateForDoctor({ doctor, fromKey, toKey, slotDuration = DEFAULT_SLOT_MINUTES }) {
  if (!doctor) return { created: 0, candidates: 0, skipped: 0, through: null };

  const template = doctor.weeklyAvailability || [];
  // Nothing to expand. Not an error: a doctor who has never set availability is
  // exactly who the warning banner is for.
  if (!template.length) return { created: 0, candidates: 0, skipped: 0, through: null };

  const clinics = await Clinic.find({ doctorId: doctor._id }).lean();
  const clinicsById = new Map(clinics.map((c) => [String(c._id), c]));

  // The doctor's own zone, for interpreting which calendar day it is. Falls
  // back to their first clinic, then the default.
  const doctorTz = clinics[0]?.timezone || DEFAULT_TIMEZONE;

  const byDay = {};
  for (const w of template) byDay[w.day] = w;

  // Dates the doctor marked absent. Compared as date KEYS in the clinic's zone,
  // not as Date objects, so a stored UTC-midnight value cannot land on the
  // wrong side of a day boundary.
  const absent = new Set((doctor.absentDates || []).map((d) => toDateKey(d, doctorTz)));

  const candidates = [];
  for (const dateKey of eachDay(fromKey, toKey, doctorTz, HORIZON_DAYS + 7)) {
    if (absent.has(dateKey)) continue;
    const dayTemplate = byDay[weekdayName(dateKey, doctorTz)];
    if (!dayTemplate) continue;

    for (const slot of expandDay({ dateKey, dayTemplate, clinicsById, slotDuration })) {
      candidates.push({ ...slot, doctorId: doctor._id });
    }
  }

  if (!candidates.length) return { created: 0, candidates: 0, skipped: 0, through: null };

  // De-duplicate against what already exists, keyed on the INSTANT rather than
  // a formatted date string — the old key used a server-timezone date, which
  // disagreed with the UTC-midnight values actually stored.
  const existing = await Slot.find({
    doctorId: doctor._id,
    startUtc: {
      $gte: candidates.reduce((a, c) => (c.startUtc < a ? c.startUtc : a), candidates[0].startUtc),
      $lte: candidates.reduce((a, c) => (c.startUtc > a ? c.startUtc : a), candidates[0].startUtc),
    },
  })
    .select('startUtc type clinicId')
    .lean();

  const key = (s) =>
    `${new Date(s.startUtc).getTime()}_${s.type}_${s.clinicId ? String(s.clinicId) : 'none'}`;
  const seen = new Set(existing.map(key));

  const docs = [];
  for (const c of candidates) {
    const k = key(c);
    if (seen.has(k)) continue;
    seen.add(k);
    docs.push(c);
  }

  if (docs.length) {
    // ordered:false so one duplicate (a concurrent generation, or the partial
    // unique index catching a race) cannot abandon the rest of the batch.
    try {
      await Slot.insertMany(docs, { ordered: false });
    } catch (e) {
      // E11000 here means the unique index did its job; everything else inserted.
      if (e.code !== 11000) throw e;
    }
  }

  const through = candidates.reduce(
    (a, c) => (c.startUtc > a ? c.startUtc : a),
    candidates[0].startUtc
  );

  return {
    created: docs.length,
    candidates: candidates.length,
    skipped: candidates.length - docs.length,
    through: toDateKey(through, doctorTz),
  };
}

/**
 * Top a doctor back up to the full horizon, generating only what is missing.
 * Safe to call repeatedly; this is what the cron job runs.
 */
async function ensureHorizon(doctor, slotDuration = DEFAULT_SLOT_MINUTES) {
  const clinics = await Clinic.find({ doctorId: doctor._id }).select('timezone').lean();
  const tz = clinics[0]?.timezone || DEFAULT_TIMEZONE;
  const from = todayKey(tz);
  const to = addDays(from, HORIZON_DAYS, tz);
  return generateForDoctor({ doctor, fromKey: from, toKey: to, slotDuration });
}

/**
 * How much bookable runway a doctor has left.
 *
 * Drives the doctor-facing warning. `daysRemaining: 0` means a patient looking
 * at this doctor right now sees an empty calendar.
 */
async function availabilityRunway(doctorId, tz = DEFAULT_TIMEZONE) {
  const last = await Slot.findOne({
    doctorId,
    status: 'available',
    startUtc: { $gt: new Date() },
  })
    .sort({ startUtc: -1 })
    .select('startUtc')
    .lean();

  if (!last) return { lastDate: null, daysRemaining: 0, hasTemplate: null };

  const lastKey = toDateKey(last.startUtc, tz);
  const days = Math.max(
    0,
    Math.round((new Date(last.startUtc).getTime() - Date.now()) / 86400000)
  );
  return { lastDate: lastKey, daysRemaining: days };
}

/** The cron entry point: refresh every verified, active doctor. */
async function refreshAllDoctors() {
  const doctors = await Doctor.find({
    isActive: true,
    verificationStatus: 'verified',
    'weeklyAvailability.0': { $exists: true },
  }).select('_id weeklyAvailability absentDates');

  let created = 0;
  let touched = 0;
  for (const doctor of doctors) {
    try {
      const r = await ensureHorizon(doctor);
      created += r.created;
      if (r.created) touched += 1;
    } catch (e) {
      // One doctor's bad template must not stop the rest.
      console.error(`[slots] horizon refresh failed doctor=${doctor._id}: ${e.message}`);
    }
  }
  return { doctors: doctors.length, touched, created };
}

module.exports = {
  HORIZON_DAYS,
  DEFAULT_SLOT_MINUTES,
  generateForDoctor,
  ensureHorizon,
  availabilityRunway,
  refreshAllDoctors,
};
