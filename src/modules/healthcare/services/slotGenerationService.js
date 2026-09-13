const Slot = require('../models/Slot');
const Clinic = require('../models/Clinic');
const Doctor = require('../models/Doctor');
const { expandDay, resolveDoctorTimezone } = require('./availabilityService');
const { todayKey, addDays, eachDay, weekdayName, toDateKey } = require('../../../utils/time');

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
 * Upper bound on slots one generation may produce. A 5-minute slot length
 * across 60 days of long days is tens of thousands of inserts — beyond what a
 * 30-second serverless function can write, and never what a doctor meant.
 */
const MAX_CANDIDATES = 20000;

class GenerationLimitError extends Error {
  constructor(count) {
    super(
      `These hours would create more than ${MAX_CANDIDATES} slots. ` +
        'Use a longer slot length or fewer hours.'
    );
    this.code = 'TOO_MANY_SLOTS';
    this.statusCode = 400;
    this.count = count;
  }
}

/** The slot length to use for a doctor: an explicit valid override, their setting, or the default. */
function slotMinutesFor(doctor, override) {
  for (const value of [override, doctor && doctor.slotDuration]) {
    const n = Number(value);
    if (value != null && Number.isInteger(n) && n >= 5 && n <= 240) return n;
  }
  return DEFAULT_SLOT_MINUTES;
}

/** Calendar days the doctor is away: time-off ranges plus legacy absentDates. */
function awayDayKeys(doctor, tz) {
  const keys = new Set();
  for (const range of (doctor && doctor.timeOff) || []) {
    for (const key of eachDay(range.from, range.to, tz, 366)) keys.add(key);
  }
  // Legacy absentDates, compared as date KEYS in the doctor's zone, not as
  // Date objects, so a stored UTC-midnight value cannot land on the wrong day.
  for (const d of (doctor && doctor.absentDates) || []) keys.add(toDateKey(d, tz));
  return keys;
}

/** The doctor's clinics that can still host appointments. */
function activeClinicsFor(doctorId) {
  return Clinic.find({ doctorId, isActive: { $ne: false } }).lean();
}

/**
 * Pure: every slot the template describes over [fromKey, toKey].
 * Throws GenerationLimitError past MAX_CANDIDATES.
 */
function buildTemplateCandidates({ doctor, clinics, fromKey, toKey, slotDuration }) {
  const template = (doctor && doctor.weeklyAvailability) || [];
  if (!template.length) return [];

  const clinicsById = new Map((clinics || []).map((c) => [String(c._id), c]));
  const tz = resolveDoctorTimezone(doctor, clinics);
  const byDay = {};
  for (const w of template) byDay[w.day] = w;
  const away = awayDayKeys(doctor, tz);

  const out = [];
  for (const dateKey of eachDay(fromKey, toKey, tz, HORIZON_DAYS + 7)) {
    if (away.has(dateKey)) continue;
    const dayTemplate = byDay[weekdayName(dateKey, tz)];
    if (!dayTemplate) continue;

    const slots = expandDay({
      dateKey,
      dayTemplate,
      clinicsById,
      slotDuration,
      breakBetween: (doctor && doctor.bufferMinutes) || 0,
      defaultTz: tz,
      includeOnline: !doctor || doctor.videoConsultation !== false,
    });
    for (const slot of slots) out.push({ ...slot, doctorId: doctor._id });
    if (out.length > MAX_CANDIDATES) throw new GenerationLimitError(out.length);
  }
  return out;
}

const clinicKey = (s) => (s.clinicId ? String(s.clinicId) : 'none');
const dayOf = (s) => s.dateKey || toDateKey(s.startUtc, s.clinicTimezone);

/**
 * Pure: which candidates can be inserted alongside the slots that already exist.
 *
 * Keyed on OVERLAP, not on an identical start time. The old key was
 * `startUtc_type_clinic`, so after a doctor changed 30-minute slots to 20 the
 * existing 09:00–09:30 did not match the new 09:20 candidate, and 09:20–09:40
 * was inserted on top of it.
 *
 *   · same type and clinic overlapping an existing slot   → skipped (OVERLAPS_EXISTING)
 *   · in-clinic overlapping in-clinic at another clinic   → skipped (OVERLAPS_OTHER_CLINIC)
 *   · overlapping any slot that already has a booking     → inserted as 'held'
 *     (a video 10:00 next to a booked in-clinic 10:00 cannot be offered)
 *
 * @returns {{ docs: object[], skipped: Array<{ slot: object, reason: string }> }}
 */
function planInserts(candidates, existing) {
  const byDay = new Map();
  const bucket = (day) => {
    if (!byDay.has(day)) byDay.set(day, []);
    return byDay.get(day);
  };
  const remember = (s, id) =>
    bucket(dayOf(s)).push({
      id,
      start: new Date(s.startUtc).getTime(),
      end: new Date(s.endUtc).getTime(),
      type: s.type,
      clinic: clinicKey(s),
      booked: (s.bookedCount || 0) > 0,
    });

  for (const s of existing || []) {
    if (s.startUtc && s.endUtc) remember(s, s._id);
  }

  const docs = [];
  const skipped = [];
  const ordered = [...(candidates || [])].sort((a, b) => new Date(a.startUtc) - new Date(b.startUtc));

  for (const c of ordered) {
    const start = new Date(c.startUtc).getTime();
    const end = new Date(c.endUtc).getTime();
    const overlapping = bucket(dayOf(c)).filter((x) => x.start < end && start < x.end);

    // A video consultation has no location, so two overlapping video slots
    // are the same offering whichever clinic they are nominally "from".
    if (overlapping.some((x) => x.type === c.type && (c.type === 'video' || x.clinic === clinicKey(c)))) {
      skipped.push({ slot: c, reason: 'OVERLAPS_EXISTING' });
      continue;
    }
    if (c.type === 'in-clinic' && overlapping.some((x) => x.type === 'in-clinic' && x.clinic !== clinicKey(c))) {
      skipped.push({ slot: c, reason: 'OVERLAPS_OTHER_CLINIC' });
      continue;
    }

    const holder = overlapping.find((x) => x.booked);
    const doc = holder ? { ...c, status: 'held', heldBy: holder.id } : c;
    docs.push(doc);
    remember(doc, null);
  }

  return { docs, skipped };
}

/**
 * Generate slots for one doctor across a date range.
 *
 * Idempotent: re-running over a range that is already populated inserts
 * nothing. That is what makes it safe to run from a cron job every day.
 *
 * @returns {{created:number, candidates:number, skipped:number, through:string|null}}
 */
async function generateForDoctor({ doctor, fromKey, toKey, slotDuration, clinics }) {
  if (!doctor) return { created: 0, candidates: 0, skipped: 0, through: null };
  if (!(doctor.weeklyAvailability || []).length) {
    // Nothing to expand. Not an error: a doctor who has never set availability
    // is exactly who the warning banner is for.
    return { created: 0, candidates: 0, skipped: 0, through: null };
  }

  const clinicList = clinics || (await activeClinicsFor(doctor._id));
  const tz = resolveDoctorTimezone(doctor, clinicList);
  const candidates = buildTemplateCandidates({
    doctor,
    clinics: clinicList,
    fromKey,
    toKey,
    slotDuration: slotMinutesFor(doctor, slotDuration),
  });
  if (!candidates.length) return { created: 0, candidates: 0, skipped: 0, through: null };

  let minStart = candidates[0].startUtc;
  let maxEnd = candidates[0].endUtc;
  for (const c of candidates) {
    if (c.startUtc < minStart) minStart = c.startUtc;
    if (c.endUtc > maxEnd) maxEnd = c.endUtc;
  }

  const existing = await Slot.find({
    doctorId: doctor._id,
    startUtc: { $lt: maxEnd },
    endUtc: { $gt: minStart },
  })
    .select('startUtc endUtc type clinicId bookedCount dateKey clinicTimezone')
    .lean();

  const { docs } = planInserts(candidates, existing);

  let created = docs.length;
  if (docs.length) {
    // ordered:false so one duplicate (a concurrent generation, or the partial
    // unique index catching a race) cannot abandon the rest of the batch.
    try {
      await Slot.insertMany(docs, { ordered: false });
    } catch (e) {
      // E11000 here means the unique index did its job; everything else inserted.
      if (e.code !== 11000) throw e;
      created = (e.insertedDocs && e.insertedDocs.length) || e.result?.insertedCount || 0;
    }
  }

  let through = candidates[0].startUtc;
  for (const c of candidates) if (c.startUtc > through) through = c.startUtc;

  return {
    created,
    candidates: candidates.length,
    skipped: candidates.length - docs.length,
    through: toDateKey(through, tz),
  };
}

/**
 * Top a doctor back up to the full horizon, generating only what is missing.
 * Safe to call repeatedly; this is what the cron job runs.
 */
async function ensureHorizon(doctor, slotDuration) {
  const clinics = await activeClinicsFor(doctor._id);
  const tz = resolveDoctorTimezone(doctor, clinics);
  const from = todayKey(tz);
  const to = addDays(from, HORIZON_DAYS, tz);
  return generateForDoctor({ doctor, fromKey: from, toKey: to, slotDuration, clinics });
}

/**
 * How much bookable runway a doctor has left.
 *
 * Drives the doctor-facing warning. `daysRemaining: 0` means a patient looking
 * at this doctor right now sees an empty calendar.
 */
async function availabilityRunway(doctorId, tz) {
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
  })
    .select('_id weeklyAvailability absentDates timeOff slotDuration bufferMinutes videoConsultation timezone')
    .lean();

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
  MAX_CANDIDATES,
  GenerationLimitError,
  slotMinutesFor,
  awayDayKeys,
  activeClinicsFor,
  buildTemplateCandidates,
  planInserts,
  generateForDoctor,
  ensureHorizon,
  availabilityRunway,
  refreshAllDoctors,
};
