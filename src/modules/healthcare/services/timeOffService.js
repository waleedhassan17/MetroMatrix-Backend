const mongoose = require('mongoose');
const Doctor = require('../models/Doctor');
const Slot = require('../models/Slot');
const Appointment = require('../models/Appointment');
const slotService = require('./slotService');
const {
  slotMinutesFor,
  activeClinicsFor,
  buildTemplateCandidates,
  awayDayKeys,
  generateForDoctor,
  HORIZON_DAYS,
} = require('./slotGenerationService');
const { slotKey } = require('./templatePlanner');
const {
  isDateKey,
  todayKey,
  addDays,
  daysBetween,
  eachDay,
  paddedRange,
  toDateKey,
} = require('../../../utils/time');

// ============================================================================
// Time off: leave as date ranges, with a reason.
//
// This replaces `absentDates` (one Date per day, no reason) and, more
// importantly, what saving them did: every appointment on a newly-absent day
// was cancelled on the spot — no refund, the slot's booking count never
// released, and no chance for the doctor to see who was affected first. It
// also only caught slots whose status read 'booked', so partly-booked group
// consultations were missed, and it found "the day" through the server's
// clock, so it blocked the wrong day's slots.
//
// Now: the doctor previews the appointments inside the range and chooses to
// keep them or cancel them. Cancelling refunds, releases and notifies — once
// each — and only the appointments the doctor actually saw are cancelled.
// ============================================================================

const MAX_SPAN_DAYS = 90;
const MAX_AHEAD_DAYS = 365;
const MAX_CANCELLATIONS = 100;
const CANCEL_BUDGET_MS = 20000;
const REASON_MAX = 200;
const ACTIVE_STATUSES = ['pending', 'confirmed'];

class TimeOffError extends Error {
  constructor(code, message, statusCode = 400, data = undefined) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.data = data;
  }
}

/** Validate and normalise `{ from, to, reason }`. Pure. */
function validateTimeOffInput(input = {}, today) {
  const from = input.from;
  const to = input.to || input.from;
  if (!isDateKey(from) || !isDateKey(to)) {
    throw new TimeOffError('VALIDATION', 'Choose a start and an end date');
  }
  if (to < from) throw new TimeOffError('VALIDATION', 'The end date must be on or after the start date');
  if (from < today) throw new TimeOffError('VALIDATION', 'Time off cannot start in the past');
  if (daysBetween(today, to) > MAX_AHEAD_DAYS) {
    throw new TimeOffError('VALIDATION', `Time off can be planned at most ${MAX_AHEAD_DAYS} days ahead`);
  }
  if (daysBetween(from, to) + 1 > MAX_SPAN_DAYS) {
    throw new TimeOffError('VALIDATION', `One time-off entry can cover at most ${MAX_SPAN_DAYS} days`);
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length > REASON_MAX) {
    throw new TimeOffError('VALIDATION', `Keep the reason under ${REASON_MAX} characters`);
  }
  return { from, to, reason };
}

/** Inclusive date-key ranges share at least one day. Pure. */
const rangesOverlap = (a, b) => a.from <= b.to && b.from <= a.to;

/** Collapse day keys into contiguous `{from, to}` ranges. Pure. */
function mergeConsecutiveDays(keys = []) {
  const sorted = [...new Set(keys.filter(isDateKey))].sort();
  const out = [];
  for (const key of sorted) {
    const last = out[out.length - 1];
    if (last && addDays(last.to, 1) === key) last.to = key;
    else out.push({ from: key, to: key });
  }
  return out;
}

/** The two id lists name exactly the same appointments. Pure. */
function sameIdSet(a = [], b = []) {
  const left = new Set(a.map(String));
  const right = new Set(b.map(String));
  return left.size === right.size && [...left].every((id) => right.has(id));
}

const toTimeOffItem = (r) => ({
  id: String(r._id),
  from: r.from,
  to: r.to,
  reason: r.reason || '',
  createdAt: r.createdAt || null,
  legacy: !!r.legacy,
  days: daysBetween(r.from, r.to) + 1,
});

const toConflictItem = (a) => ({
  appointmentId: a._id,
  slotId: a.slotId,
  status: a.status,
  patientName: (a.patientId && a.patientId.fullName) || (a.patientInfo && a.patientInfo.name) || 'Patient',
  type: a.type,
  date: a.dateKey,
  startTime: a.startTime,
  endTime: a.endTime,
  startUtc: a.startUtc,
  clinic: a.clinicId && a.clinicId.name ? { id: String(a.clinicId._id), name: a.clinicId.name } : null,
  reason: 'IN_TIME_OFF',
});

/** Future slots of this doctor on the local days from..to. */
function futureSlotsFilter(doctorId, from, to, tz, now) {
  const range = paddedRange(from, to, tz);
  return { doctorId, dateKey: range.dateKey, startUtc: { ...range.startUtc, $gt: now } };
}

/** Active appointments inside a range — what the doctor must decide about. */
async function findConflicts(doctorId, from, to, tz) {
  const rows = await Appointment.find({
    doctorId,
    ...paddedRange(from, to, tz),
    status: { $in: ACTIVE_STATUSES },
  })
    .select('_id slotId status type patientId patientInfo.name clinicId dateKey startTime endTime startUtc')
    .populate('patientId', 'fullName')
    .populate('clinicId', 'name')
    .sort({ startUtc: 1 })
    .limit(MAX_CANCELLATIONS + 1)
    .lean();
  return rows.map(toConflictItem);
}

/** What adding this time off would affect. */
async function previewTimeOff(doctor, input, tz) {
  const { from, to } = validateTimeOffInput(input, todayKey(tz));
  const now = new Date();
  const [conflicts, slotsToBlock] = await Promise.all([
    findConflicts(doctor._id, from, to, tz),
    Slot.countDocuments({
      ...futureSlotsFilter(doctor._id, from, to, tz, now),
      status: { $in: ['available', 'held', 'booked'] },
    }),
  ]);
  const overlapping = (doctor.timeOff || []).find((r) => rangesOverlap(r, { from, to }));
  return {
    from,
    to,
    days: daysBetween(from, to) + 1,
    slotsToBlock,
    conflicts,
    overlapsExisting: overlapping ? toTimeOffItem(overlapping) : null,
  };
}

/**
 * Add time off.
 *
 * @param {object} input `{ from, to, reason, onConflict: 'keep'|'cancel', confirmAppointmentIds }`
 */
async function addTimeOff(doctor, input, tz) {
  const deadline = Date.now() + CANCEL_BUDGET_MS;
  const { from, to, reason } = validateTimeOffInput(input, todayKey(tz));
  const onConflict = input.onConflict === 'cancel' ? 'cancel' : 'keep';

  const conflicts = await findConflicts(doctor._id, from, to, tz);
  if (onConflict === 'cancel') {
    if (conflicts.length > MAX_CANCELLATIONS) {
      throw new TimeOffError(
        'TOO_MANY_CANCELLATIONS',
        `More than ${MAX_CANCELLATIONS} appointments fall in this period. Choose a shorter range.`
      );
    }
    // Only cancel appointments the doctor has seen. A booking made after the
    // preview must not be cancelled on their behalf.
    if (!sameIdSet(conflicts.map((c) => c.appointmentId), input.confirmAppointmentIds || [])) {
      throw new TimeOffError(
        'CONFLICTS_CHANGED',
        'The appointments in this period have changed. Review them again before cancelling.',
        409,
        { conflicts }
      );
    }
  }

  const entry = {
    _id: new mongoose.Types.ObjectId(),
    from,
    to,
    reason,
    createdAt: new Date(),
    legacy: !!input.legacy,
  };
  // Atomic: pushed only if no existing entry overlaps. `YYYY-MM-DD` strings
  // compare in calendar order.
  const pushed = await Doctor.updateOne(
    { _id: doctor._id, timeOff: { $not: { $elemMatch: { from: { $lte: to }, to: { $gte: from } } } } },
    { $push: { timeOff: entry } }
  );
  if (!pushed.modifiedCount) {
    throw new TimeOffError('OVERLAPS_TIME_OFF', 'You already have time off during these dates.', 409);
  }

  // Close the days. Booked slots are closed too — the booking stays (unless
  // cancelled below), but a later cancellation must not reopen a day off.
  // Slots the doctor already closed keep saying so.
  const blocked = await Slot.updateMany(
    {
      ...futureSlotsFilter(doctor._id, from, to, tz, new Date()),
      status: { $in: ['available', 'held', 'booked'] },
    },
    { $set: { status: 'blocked', blockedBy: 'time_off', heldBy: null } }
  );

  const cancelled = [];
  const failed = [];
  const pendingCancellations = [];
  if (onConflict === 'cancel') {
    const { cancelByDoctor } = require('./appointmentService');
    const note = reason ? `Doctor on leave: ${reason}` : 'Doctor on leave';
    for (const c of conflicts) {
      if (Date.now() > deadline) {
        pendingCancellations.push(c.appointmentId);
        continue;
      }
      try {
        const result = await cancelByDoctor(c.appointmentId, doctor._id, note);
        if (result.error) failed.push({ appointmentId: c.appointmentId, message: result.error });
        else cancelled.push({ appointmentId: c.appointmentId, refunded: result.refunded });
      } catch (err) {
        failed.push({ appointmentId: c.appointmentId, message: err.message });
      }
    }
  }

  return {
    timeOff: toTimeOffItem(entry),
    blockedSlots: blocked.modifiedCount || 0,
    conflicts: onConflict === 'keep' ? conflicts : [],
    cancelled,
    failed,
    // Out of time: cancel these through the appointment cancel endpoint.
    pendingCancellations,
  };
}

/** Change the reason. Dates are changed by removing and re-adding. */
async function updateTimeOffReason(doctor, id, reason) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length > REASON_MAX) {
    throw new TimeOffError('VALIDATION', `Keep the reason under ${REASON_MAX} characters`);
  }
  const res = await Doctor.updateOne(
    { _id: doctor._id, 'timeOff._id': id },
    { $set: { 'timeOff.$.reason': text } }
  );
  if (!res.matchedCount) throw new TimeOffError('NOT_FOUND', 'Time off not found', 404);
  const entry = (doctor.timeOff || []).find((r) => String(r._id) === String(id));
  return toTimeOffItem({ ...entry, reason: text });
}

/**
 * Remove time off and bring those days back in line with the weekly hours:
 * slots it closed reopen, template slots the hours no longer want go away, and
 * days the generator skipped while away are filled in.
 */
async function removeTimeOff(doctor, id, tz) {
  const entry = (doctor.timeOff || []).find((r) => String(r._id) === String(id));
  if (!entry) throw new TimeOffError('NOT_FOUND', 'Time off not found', 404);

  await Doctor.updateOne({ _id: doctor._id }, { $pull: { timeOff: { _id: entry._id } } });
  const remaining = (doctor.timeOff || []).filter((r) => String(r._id) !== String(entry._id));
  const updated = { ...doctor, timeOff: remaining };

  const today = todayKey(tz);
  if (entry.to < today) return { removed: true, reopened: 0, removedStale: 0, generated: 0 };
  const from = entry.from < today ? today : entry.from;
  const horizonEnd = addDays(today, HORIZON_DAYS, tz);
  const to = entry.to < horizonEnd ? entry.to : horizonEnd;

  // Days still covered by another entry (or legacy absentDates) stay closed.
  const stillAway = awayDayKeys(updated, tz);
  const closed = await Slot.find({
    ...futureSlotsFilter(doctor._id, from, entry.to, tz, new Date()),
    blockedBy: 'time_off',
  })
    .select('_id doctorId startUtc endUtc dateKey type clinicId source status bookedCount maxPatients')
    .lean();
  const affected = closed.filter((s) => !stillAway.has(s.dateKey));

  const clinics = await activeClinicsFor(doctor._id);
  const wanted =
    from <= to
      ? new Set(
          buildTemplateCandidates({
            doctor: updated,
            clinics,
            fromKey: from,
            toKey: to,
            slotDuration: slotMinutesFor(updated),
          }).map(slotKey)
        )
      : new Set();

  const reopenIds = [];
  const staleIds = [];
  const orphanedIds = [];
  for (const s of affected) {
    if (s.source === 'template' && !wanted.has(slotKey(s))) {
      (s.bookedCount > 0 ? orphanedIds : staleIds).push(s._id);
    } else {
      reopenIds.push(s._id);
    }
  }

  if (staleIds.length) await Slot.deleteMany({ _id: { $in: staleIds }, bookedCount: 0 });
  if (orphanedIds.length) {
    await Slot.updateMany({ _id: { $in: orphanedIds } }, { $set: { blockedBy: 'template' } });
  }
  if (reopenIds.length) {
    await require('./slotCalendarService').reopenBlockedSlots(
      { _id: { $in: reopenIds }, blockedBy: 'time_off' }
    );
    // Reopened times the doctor is booked around must not be offered.
    const reopened = await Slot.find({ _id: { $in: reopenIds } }).lean();
    for (const s of reopened) {
      if (s.bookedCount > 0) await slotService.holdOverlapping(s);
      else if (s.status === 'available') await slotService.holdIfEngaged(s);
    }
  }

  let generated = 0;
  if (from <= to) {
    const result = await generateForDoctor({ doctor: updated, fromKey: from, toKey: to, clinics });
    generated = result.created;
  }

  return { removed: true, reopened: reopenIds.length, removedStale: staleIds.length, generated };
}

/**
 * The save path of app builds that predate the hub, which send the whole list
 * of absent days. Added days become time off (bookings kept, never cancelled);
 * whole entries whose days were all removed are removed.
 */
async function syncLegacyAbsentDates(doctor, absentDates, tz) {
  const today = todayKey(tz);
  const wanted = new Set(
    (absentDates || [])
      .map((d) => (isDateKey(d) ? d : toDateKey(d, tz)))
      .filter((k) => isDateKey(k))
  );
  const current = awayDayKeys(doctor, tz);

  const added = [...wanted].filter((k) => !current.has(k) && k >= today);
  const removedDays = new Set([...current].filter((k) => !wanted.has(k) && k >= today));

  const result = { added: [], removed: 0, conflicts: [], warnings: [] };
  let working = doctor;

  for (const range of mergeConsecutiveDays(added)) {
    try {
      const r = await addTimeOff(working, { ...range, reason: 'Absent', onConflict: 'keep', legacy: true }, tz);
      result.added.push(r.timeOff);
      result.conflicts.push(...r.conflicts);
      working = {
        ...working,
        timeOff: [...(working.timeOff || []), { _id: r.timeOff.id, from: range.from, to: range.to }],
      };
    } catch (err) {
      result.warnings.push(err.message);
    }
  }

  for (const entry of doctor.timeOff || []) {
    const days = eachDay(entry.from, entry.to, tz, 366).filter((k) => k >= today);
    if (days.length && days.every((k) => removedDays.has(k))) {
      await removeTimeOff(working, entry._id, tz);
      working = { ...working, timeOff: (working.timeOff || []).filter((r) => String(r._id) !== String(entry._id)) };
      result.removed += 1;
    } else if (days.some((k) => removedDays.has(k))) {
      result.warnings.push(
        `${entry.from} – ${entry.to} is a single time-off entry; remove it as a whole from Time off.`
      );
    }
  }

  const pull = (doctor.absentDates || []).filter((d) => removedDays.has(toDateKey(d, tz)));
  if (pull.length) {
    await Doctor.updateOne({ _id: doctor._id }, { $pull: { absentDates: { $in: pull } } });
    result.removed += pull.length;
  }

  return result;
}

module.exports = {
  MAX_SPAN_DAYS,
  MAX_CANCELLATIONS,
  TimeOffError,
  validateTimeOffInput,
  rangesOverlap,
  mergeConsecutiveDays,
  sameIdSet,
  toTimeOffItem,
  findConflicts,
  previewTimeOff,
  addTimeOff,
  updateTimeOffReason,
  removeTimeOff,
  syncLegacyAbsentDates,
};
