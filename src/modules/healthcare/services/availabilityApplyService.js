const Doctor = require('../models/Doctor');
const Slot = require('../models/Slot');
const Appointment = require('../models/Appointment');
const slotService = require('./slotService');
const {
  validateSettings,
  validateWeeklyAvailability,
  resolveDoctorTimezone,
} = require('./availabilityService');
const {
  HORIZON_DAYS,
  slotMinutesFor,
  activeClinicsFor,
  buildTemplateCandidates,
  awayDayKeys,
} = require('./slotGenerationService');
const { planTemplateChange, summarizePlan, planByDate } = require('./templatePlanner');
const { todayKey, addDays, localToUtc, toDateKey, eachDay, daysBetween } = require('../../../utils/time');

// ============================================================================
// Weekly hours: read, preview a change, apply it.
//
// Apply is written for a 30-second serverless function and for patients who
// keep booking while it runs:
//   · a version guard, so two devices cannot silently overwrite each other
//   · every delete is conditional on the slot still having no booking
//   · booked slots that fall out of the hours are kept and closed, not cancelled
//   · a time budget: past it, stop and return `partial: true`; the same request
//     again finishes the job, because the plan is recomputed from scratch
// ============================================================================

const APPLY_BUDGET_MS = 22000;
const CHUNK = 1000;
const ACTIVE_STATUSES = ['pending', 'confirmed'];
const SETTING_KEYS = ['slotDuration', 'bufferMinutes', 'videoConsultation', 'autoConfirm', 'timezone'];
const PLAN_SLOT_FIELDS =
  '_id doctorId startUtc endUtc dateKey clinicTimezone type clinicId status bookedCount maxPatients ' +
  'source blockedBy startTime endTime';

/** An error with a stable code the app can branch on. */
class AvailabilityError extends Error {
  constructor(code, message, statusCode = 400, data = undefined) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.data = data;
  }
}

const chunked = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/** The doctor's effective booking settings. */
function currentSettings(doctor) {
  return {
    slotDuration: slotMinutesFor(doctor),
    bufferMinutes: doctor.bufferMinutes || 0,
    videoConsultation: doctor.videoConsultation !== false,
    autoConfirm: !!doctor.autoConfirm,
    timezone: doctor.timezone || null,
  };
}

const toClinicItem = (c) => ({
  id: String(c._id),
  name: c.name,
  address: c.address || '',
  city: c.city || '',
  area: c.area || '',
  type: c.type || 'physical',
  timezone: c.timezone || null,
});

const toTimeOffItem = (r) => ({
  id: String(r._id),
  from: r.from,
  to: r.to,
  reason: r.reason || '',
  createdAt: r.createdAt || null,
  legacy: !!r.legacy,
  days: daysBetween(r.from, r.to) + 1,
});

/** Everything the Availability hub shows, in one response. */
async function getAvailabilityHub(doctor) {
  const clinics = await activeClinicsFor(doctor._id);
  const tz = resolveDoctorTimezone(doctor, clinics);
  const today = todayKey(tz);

  // App builds that predate the hub read `absentDates` as a list of days.
  const absentKeys = new Set();
  for (const r of doctor.timeOff || []) for (const k of eachDay(r.from, r.to, tz, 366)) absentKeys.add(k);
  for (const d of doctor.absentDates || []) absentKeys.add(toDateKey(d, tz));

  return {
    version: doctor.availabilityVersion || 0,
    timezone: tz,
    settings: currentSettings(doctor),
    // False until the doctor picks a slot length; the hub prompts for it.
    slotDurationChosen: doctor.slotDuration != null,
    weeklyAvailability: doctor.weeklyAvailability || [],
    timeOff: (doctor.timeOff || [])
      .filter((r) => r.to >= today)
      .sort((a, b) => a.from.localeCompare(b.from))
      .map(toTimeOffItem),
    clinics: clinics.map(toClinicItem),
    horizon: { days: HORIZON_DAYS, from: today, through: addDays(today, HORIZON_DAYS, tz) },
    verificationStatus: doctor.verificationStatus,

    // ── Read by app builds that predate the hub ──
    isAvailable: doctor.isAvailable !== false,
    unavailableFrom: doctor.unavailableFrom || null,
    unavailableTo: doctor.unavailableTo || null,
    absentDates: [...absentKeys].sort().map((k) => localToUtc(k, '00:00', tz)),
    videoConsultation: doctor.videoConsultation !== false,
  };
}

/**
 * Validate a proposed change and compute its plan against the live slots.
 * Throws AvailabilityError (VALIDATION / TOO_MANY_SLOTS).
 */
async function buildPlan(doctor, { weeklyAvailability, settings: incoming } = {}, { now = new Date() } = {}) {
  const picked = {};
  for (const key of SETTING_KEYS) {
    if (incoming && incoming[key] !== undefined) picked[key] = incoming[key];
  }
  const settingsCheck = validateSettings(picked);
  if (!settingsCheck.ok) {
    throw new AvailabilityError('VALIDATION', settingsCheck.errors[0].message, 400, {
      errors: settingsCheck.errors,
      warnings: [],
    });
  }
  const settings = { ...currentSettings(doctor), ...settingsCheck.value };
  const weekly = weeklyAvailability !== undefined ? weeklyAvailability : doctor.weeklyAvailability || [];

  const clinics = await activeClinicsFor(doctor._id);
  const clinicsById = new Map(clinics.map((c) => [String(c._id), c]));
  const validation = validateWeeklyAvailability(weekly, new Set(clinicsById.keys()), {
    slotDuration: settings.slotDuration,
    clinicsById,
  });
  if (!validation.ok) {
    throw new AvailabilityError('VALIDATION', validation.errors[0], 400, {
      errors: validation.issues,
      warnings: validation.warnings,
    });
  }

  const next = { ...doctor, ...settings, weeklyAvailability: weekly };
  const tz = resolveDoctorTimezone(next, clinics);
  const fromKey = todayKey(tz);
  const toKey = addDays(fromKey, HORIZON_DAYS, tz);

  let desired;
  try {
    desired = buildTemplateCandidates({
      doctor: next,
      clinics,
      fromKey,
      toKey,
      slotDuration: settings.slotDuration,
    });
  } catch (err) {
    if (err.code === 'TOO_MANY_SLOTS') throw new AvailabilityError('TOO_MANY_SLOTS', err.message, 400);
    throw err;
  }

  const horizonEnd = localToUtc(addDays(toKey, 1, tz), '00:00', tz);
  const existing = await Slot.find({
    doctorId: doctor._id,
    startUtc: { $lt: horizonEnd },
    endUtc: { $gt: now },
  })
    .select(PLAN_SLOT_FIELDS)
    .lean();

  const plan = planTemplateChange({ existing, desired, now, excludeDateKeys: awayDayKeys(next, tz) });
  return { plan, settings, weekly, tz, fromKey, toKey, horizonEnd, clinicsById, warnings: validation.warnings };
}

/** The booked appointments behind conflicting slots, for the doctor to review. */
async function describeConflicts(slots, clinicsById) {
  if (!slots.length) return [];
  const appointments = await Appointment.find({
    slotId: { $in: slots.map((s) => s._id) },
    status: { $in: ACTIVE_STATUSES },
  })
    .select('_id slotId status type patientId patientInfo.name')
    .populate('patientId', 'fullName')
    .lean();

  const bySlot = new Map();
  for (const a of appointments) {
    const key = String(a.slotId);
    if (!bySlot.has(key)) bySlot.set(key, []);
    bySlot.get(key).push(a);
  }

  const out = [];
  for (const s of slots) {
    for (const a of bySlot.get(String(s._id)) || []) {
      out.push({
        appointmentId: a._id,
        slotId: s._id,
        status: a.status,
        patientName: (a.patientId && a.patientId.fullName) || (a.patientInfo && a.patientInfo.name) || 'Patient',
        type: s.type,
        date: s.dateKey || toDateKey(s.startUtc, s.clinicTimezone),
        startTime: s.startTime,
        endTime: s.endTime,
        startUtc: s.startUtc,
        clinic: s.clinicId
          ? { id: String(s.clinicId), name: (clinicsById.get(String(s.clinicId)) || {}).name || 'Clinic' }
          : null,
        reason: 'NOT_IN_NEW_HOURS',
      });
    }
  }
  return out.sort((a, b) => new Date(a.startUtc) - new Date(b.startUtc));
}

/** What saving these hours would do, without doing it. */
async function previewTemplateChange(doctor, body) {
  const built = await buildPlan(doctor, body);
  const conflicts = await describeConflicts(built.plan.conflicts, built.clinicsById);
  return {
    valid: true,
    baseVersion: doctor.availabilityVersion || 0,
    timezone: built.tz,
    window: { from: built.fromKey, through: built.toKey },
    summary: { ...summarizePlan(built.plan), conflicts: conflicts.length },
    byDate: planByDate(built.plan),
    conflicts,
    skipped: built.plan.skipped.slice(0, 50).map(({ slot, reason }) => ({
      date: slot.dateKey,
      type: slot.type,
      startTime: slot.startTime,
      endTime: slot.endTime,
      reason,
    })),
    warnings: built.warnings,
    settings: built.settings,
  };
}

/**
 * Save weekly hours + settings and bring the published slots in line.
 *
 * @param {number|null} baseVersion the version the doctor previewed against;
 *   null skips the guard (the legacy save path of older app builds)
 */
async function applyTemplateChange(doctor, body, { baseVersion = null } = {}) {
  const deadline = Date.now() + APPLY_BUDGET_MS;
  const now = new Date();
  const built = await buildPlan(doctor, body, { now });
  const { plan } = built;

  const versionFilter = { _id: doctor._id };
  if (baseVersion !== null) {
    if (baseVersion === 0) {
      versionFilter.$or = [{ availabilityVersion: 0 }, { availabilityVersion: { $exists: false } }];
    } else {
      versionFilter.availabilityVersion = baseVersion;
    }
  }

  const saved = await Doctor.findOneAndUpdate(
    versionFilter,
    {
      $set: {
        weeklyAvailability: built.weekly,
        slotDuration: built.settings.slotDuration,
        bufferMinutes: built.settings.bufferMinutes,
        videoConsultation: built.settings.videoConsultation,
        autoConfirm: built.settings.autoConfirm,
        timezone: built.settings.timezone,
      },
      $inc: { availabilityVersion: 1 },
    },
    { new: true }
  )
    .select('availabilityVersion')
    .lean();

  if (!saved) {
    const current = await Doctor.findById(doctor._id).select('availabilityVersion').lean();
    throw new AvailabilityError(
      'TEMPLATE_CHANGED',
      'Your weekly hours were changed on another device. Reload to see the latest before saving.',
      409,
      { currentVersion: (current && current.availabilityVersion) || 0 }
    );
  }

  let partial = false;
  const conflictSlots = [...plan.conflicts];
  const closeForBooking = (ids) =>
    Slot.updateMany(
      { _id: { $in: ids }, bookedCount: { $gt: 0 } },
      // The booking stays. Closing the slot stops further bookings, and a later
      // cancellation leaves it closed instead of re-opening old hours.
      { $set: { status: 'blocked', blockedBy: 'template', heldBy: null } }
    );

  if (conflictSlots.length) await closeForBooking(conflictSlots.map((s) => s._id));

  let removed = 0;
  const attempted = [];
  for (const chunk of chunked(plan.remove, CHUNK)) {
    if (Date.now() > deadline) {
      partial = true;
      break;
    }
    const ids = chunk.map((s) => s._id);
    attempted.push(...ids);
    const res = await Slot.deleteMany({
      _id: { $in: ids },
      doctorId: doctor._id,
      source: 'template',
      bookedCount: 0,
    });
    removed += res.deletedCount || 0;
  }

  // A patient booked one of these between planning and deleting.
  if (removed < attempted.length) {
    const survivors = await Slot.find({ _id: { $in: attempted }, bookedCount: { $gt: 0 } })
      .select(PLAN_SLOT_FIELDS)
      .lean();
    if (survivors.length) {
      await closeForBooking(survivors.map((s) => s._id));
      conflictSlots.push(...survivors);
    }
  }

  let added = 0;
  if (!partial) {
    for (const chunk of chunked(plan.add, CHUNK)) {
      if (Date.now() > deadline) {
        partial = true;
        break;
      }
      try {
        const docs = await Slot.insertMany(chunk, { ordered: false });
        added += docs.length;
      } catch (err) {
        // Duplicates from a concurrent run: the unique index did its job.
        if (!err.writeErrors && err.code !== 11000) throw err;
        const failures = Array.isArray(err.writeErrors) ? err.writeErrors.length : 1;
        added += Math.max(0, chunk.length - failures);
      }
    }
  }

  // A booking that landed while this ran may overlap a slot it just inserted.
  if (!partial && added) {
    const booked = await Slot.find({
      doctorId: doctor._id,
      bookedCount: { $gt: 0 },
      startUtc: { $gt: now, $lt: built.horizonEnd },
    })
      .select('_id doctorId startUtc endUtc')
      .lean();
    for (const b of booked) {
      if (Date.now() > deadline) {
        partial = true;
        break;
      }
      await slotService.holdOverlapping(b);
    }
  }

  const conflicts = await describeConflicts(conflictSlots, built.clinicsById);

  return {
    version: saved.availabilityVersion,
    partial,
    summary: {
      removed,
      added,
      kept: plan.keep.length,
      skipped: plan.skipped.length,
      conflicts: conflicts.length,
    },
    conflicts,
    weeklyAvailability: built.weekly,
    settings: built.settings,
    warnings: built.warnings,
    timezone: built.tz,
  };
}

/** Settings that do not change any slot, saved on their own. */
async function updateBookingSettings(doctor, body = {}) {
  const keys = Object.keys(body);
  const slotAffecting = keys.filter((k) => k !== 'autoConfirm');
  if (slotAffecting.length) {
    throw new AvailabilityError(
      'SLOT_SETTINGS_REQUIRE_APPLY',
      `${slotAffecting.join(', ')} change your slots — save them together with your weekly hours.`,
      400
    );
  }
  const check = validateSettings({ autoConfirm: body.autoConfirm });
  if (!check.ok || check.value.autoConfirm === undefined) {
    throw new AvailabilityError('VALIDATION', 'autoConfirm must be true or false', 400);
  }
  await Doctor.updateOne({ _id: doctor._id }, { $set: { autoConfirm: check.value.autoConfirm } });
  return { ...currentSettings(doctor), autoConfirm: check.value.autoConfirm };
}

module.exports = {
  APPLY_BUDGET_MS,
  AvailabilityError,
  currentSettings,
  toTimeOffItem,
  getAvailabilityHub,
  buildPlan,
  previewTemplateChange,
  applyTemplateChange,
  updateBookingSettings,
};
