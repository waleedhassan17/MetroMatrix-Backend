const Slot = require('../models/Slot');
const Clinic = require('../models/Clinic');
const Appointment = require('../models/Appointment');
const slotService = require('./slotService');
const { HORIZON_DAYS, awayDayKeys, planInserts, slotMinutesFor } = require('./slotGenerationService');
const { toTimeOffItem } = require('./timeOffService');
const {
  HHMM,
  isDateKey,
  paddedRange,
  todayKey,
  addDays,
  daysBetween,
  localToUtc,
  toMinutes,
  fromMinutes,
  safeZone,
  weekdayName,
} = require('../../../utils/time');

// ============================================================================
// The Availability hub's calendar: one day's slots and what the doctor can do
// with each, extra one-off hours, and closing a slot or a whole day.
// ============================================================================

const ACTIVE_STATUSES = ['pending', 'confirmed'];
const MAX_PATIENTS_CAP = 10;
const MAX_ONE_OFF_SLOTS = 200;
const MAX_SUMMARY_DAYS = 62;
const SLOT_FIELDS =
  '_id doctorId clinicId date dateKey startTime endTime startUtc endUtc clinicTimezone type status ' +
  'source blockedBy heldBy maxPatients bookedCount';

class CalendarError extends Error {
  constructor(code, message, statusCode = 400, data = undefined) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.data = data;
  }
}

/**
 * What a slot is, from the doctor's side, and what they may do with it. Pure.
 *
 *   booked    — a confirmed (or completed) appointment
 *   requested — a patient asked; waiting for the doctor's approval
 *   past      — already started; nothing can be changed
 *   held      — overlaps another booked slot, so it cannot be offered
 *   blocked   — closed (by the doctor, time off, or old weekly hours)
 *   open      — bookable
 */
function deriveSlotState(slot, appointments = [], now = new Date()) {
  const booked = slot.bookedCount || 0;
  const capacity = slot.maxPatients || 1;
  const isPast = !!slot.startUtc && new Date(slot.startUtc) <= now;

  let state;
  if (appointments.some((a) => a.status === 'confirmed' || a.status === 'completed')) state = 'booked';
  else if (appointments.some((a) => a.status === 'pending')) state = 'requested';
  else if (isPast) state = 'past';
  else if (slot.status === 'held') state = 'held';
  else if (slot.status === 'blocked') state = 'blocked';
  else if (booked >= capacity) state = 'booked';
  else state = 'open';

  const hasActive = appointments.some((a) => ACTIVE_STATUSES.includes(a.status));
  const canBlock = !isPast && slot.status !== 'blocked' && booked < capacity;
  // Only what the doctor closed can be reopened here: time off is lifted from
  // Time off, and old weekly hours come back by changing the weekly hours.
  const canUnblock = !isPast && slot.status === 'blocked' && (!slot.blockedBy || slot.blockedBy === 'doctor');
  // Weekly-hours slots are closed, not deleted: the nightly job would recreate them.
  const canDelete = !isPast && slot.source !== 'template' && booked === 0 && !hasActive;
  const canEdit = canDelete && (state === 'open' || state === 'blocked');

  return { state, isPast, canBlock, canUnblock, canDelete, canEdit };
}

/** A slot as the doctor app shows it. */
function toDoctorSlot(slot, appointments, clinicsById, slotsById, now, fallbackDate) {
  const clinic = slot.clinicId ? clinicsById.get(String(slot.clinicId)) : null;
  const holder = slot.heldBy && slotsById ? slotsById.get(String(slot.heldBy)) : null;
  return {
    id: String(slot._id),
    date: slot.dateKey || fallbackDate || null,
    startTime: slot.startTime,
    endTime: slot.endTime,
    startUtc: slot.startUtc,
    endUtc: slot.endUtc,
    type: slot.type,
    clinic: slot.clinicId
      ? { id: String(slot.clinicId), name: (clinic && clinic.name) || 'Clinic', address: (clinic && clinic.address) || '' }
      : null,
    source: slot.source || null,
    status: slot.status,
    blockedBy: slot.blockedBy || null,
    ...deriveSlotState(slot, appointments, now),
    maxPatients: slot.maxPatients || 1,
    bookedCount: slot.bookedCount || 0,
    appointments: appointments.map((a) => ({
      id: String(a._id),
      status: a.status,
      type: a.type,
      patientName: (a.patientId && a.patientId.fullName) || (a.patientInfo && a.patientInfo.name) || 'Patient',
    })),
    heldBy: holder
      ? { id: String(holder._id), type: holder.type, startTime: holder.startTime, endTime: holder.endTime }
      : null,
  };
}

async function appointmentsBySlot(slotIds) {
  const map = new Map();
  if (!slotIds.length) return map;
  const rows = await Appointment.find({
    slotId: { $in: slotIds },
    status: { $in: ['pending', 'confirmed', 'completed'] },
  })
    .select('_id slotId status type patientId patientInfo.name')
    .populate('patientId', 'fullName')
    .lean();
  for (const a of rows) {
    const key = String(a.slotId);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(a);
  }
  return map;
}

const clinicMap = async (doctorId) =>
  new Map(
    (await Clinic.find({ doctorId }).select('_id name address timezone isActive').lean()).map((c) => [String(c._id), c])
  );

/** One day of the doctor's calendar. */
async function getDayView(doctor, date, tz, now = new Date()) {
  if (!isDateKey(date)) throw new CalendarError('VALIDATION', 'date must be YYYY-MM-DD');
  const zone = safeZone(tz);
  const legacy = {
    $gte: localToUtc(date, '00:00', zone),
    $lt: localToUtc(addDays(date, 1, zone), '00:00', zone),
  };

  const [slots, clinicsById] = await Promise.all([
    Slot.find({
      doctorId: doctor._id,
      // `dateKey` for everything backfilled; the instant for rows that are not yet.
      $or: [paddedRange(date, date, zone), { dateKey: null, startUtc: legacy }],
    })
      .select(SLOT_FIELDS)
      .sort({ startUtc: 1, startTime: 1 })
      .lean(),
    clinicMap(doctor._id),
  ]);

  const bySlot = await appointmentsBySlot(slots.map((s) => s._id));
  const byId = new Map(slots.map((s) => [String(s._id), s]));
  const items = slots.map((s) => toDoctorSlot(s, bySlot.get(String(s._id)) || [], clinicsById, byId, now, date));

  const summary = { open: 0, requested: 0, booked: 0, held: 0, blocked: 0, past: 0, total: items.length };
  for (const item of items) summary[item.state] += 1;

  const today = todayKey(zone);
  const timeOff = (doctor.timeOff || []).find((r) => r.from <= date && date <= r.to);
  const dayName = weekdayName(date, zone);

  return {
    date,
    timezone: zone,
    isPast: date < today,
    inHorizon: date >= today && daysBetween(today, date) <= HORIZON_DAYS,
    timeOff: timeOff ? toTimeOffItem(timeOff) : null,
    template: (doctor.weeklyAvailability || []).find((d) => d.day === dayName) || null,
    summary,
    slots: items,
  };
}

/** Per-day counts across a range, for the calendar strip's dots. */
async function getCalendarSummary(doctor, from, to, tz, now = new Date()) {
  const zone = safeZone(tz);
  if (!isDateKey(from) || !isDateKey(to)) throw new CalendarError('VALIDATION', 'from and to must be YYYY-MM-DD');
  const span = daysBetween(from, to);
  if (span < 0) throw new CalendarError('VALIDATION', 'to must not be before from');
  if (span + 1 > MAX_SUMMARY_DAYS) {
    throw new CalendarError('VALIDATION', `At most ${MAX_SUMMARY_DAYS} days at a time`);
  }
  const range = paddedRange(from, to, zone);

  const [slotRows, requestRows] = await Promise.all([
    Slot.aggregate([
      { $match: { doctorId: doctor._id, ...range } },
      {
        $group: {
          _id: '$dateKey',
          total: { $sum: 1 },
          open: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$status', 'available'] },
                    { $gt: ['$startUtc', now] },
                    { $lt: ['$bookedCount', '$maxPatients'] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          booked: { $sum: { $cond: [{ $gt: ['$bookedCount', 0] }, 1, 0] } },
          blocked: { $sum: { $cond: [{ $eq: ['$status', 'blocked'] }, 1, 0] } },
        },
      },
    ]),
    Appointment.aggregate([
      { $match: { doctorId: doctor._id, ...range, status: 'pending' } },
      { $group: { _id: '$dateKey', requested: { $sum: 1 } } },
    ]),
  ]);

  const away = awayDayKeys(doctor, zone);
  const byDate = new Map();
  const entry = (date) => {
    if (!byDate.has(date)) {
      byDate.set(date, { date, total: 0, open: 0, booked: 0, blocked: 0, requested: 0, timeOff: away.has(date) });
    }
    return byDate.get(date);
  };
  for (const r of slotRows) Object.assign(entry(r._id), { total: r.total, open: r.open, booked: r.booked, blocked: r.blocked });
  for (const r of requestRows) entry(r._id).requested = r.requested;

  const days = [];
  for (let key = from; key <= to; key = addDays(key, 1, zone)) {
    days.push(byDate.get(key) || { date: key, total: 0, open: 0, booked: 0, blocked: 0, requested: 0, timeOff: away.has(key) });
  }
  return { from, to, timezone: zone, days };
}

/**
 * Pure: the slot documents a one-off "extra hours" request describes.
 *
 * @param {object} input `{ date, startTime, endTime, type, clinicId, split, slotDuration, maxPatients }`
 * @param {object} ctx `{ doctorId, clinicsById, doctorTz, slotDuration, bookableFrom }`
 * @returns {{ candidates: object[], skipped: object[], unusedMinutes: number }}
 */
function planOneOffSlots(input = {}, ctx) {
  const { date, startTime, endTime } = input;
  if (!isDateKey(date)) throw new CalendarError('VALIDATION', 'date must be YYYY-MM-DD');
  if (!HHMM.test(startTime || '') || !HHMM.test(endTime || '')) {
    throw new CalendarError('VALIDATION', 'startTime and endTime must be HH:MM');
  }
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  if (end <= start) throw new CalendarError('VALIDATION', 'The end time must be after the start time');

  const types = input.type === 'both' ? ['video', 'in-clinic'] : [input.type];
  if (!types.every((t) => t === 'video' || t === 'in-clinic')) {
    throw new CalendarError('VALIDATION', 'type must be video, in-clinic or both');
  }

  const maxPatients = input.maxPatients == null ? 1 : Number(input.maxPatients);
  if (!Number.isInteger(maxPatients) || maxPatients < 1 || maxPatients > MAX_PATIENTS_CAP) {
    throw new CalendarError('VALIDATION', `Patients per slot must be 1 to ${MAX_PATIENTS_CAP}`);
  }

  const split = input.split !== false;
  let duration = ctx.slotDuration;
  if (input.slotDuration !== undefined) {
    const n = Number(input.slotDuration);
    if (!Number.isInteger(n) || n < 5 || n > 240) {
      throw new CalendarError('VALIDATION', 'Slot length must be 5 to 240 minutes');
    }
    duration = n;
  }
  if (split && end - start < duration) {
    throw new CalendarError('VALIDATION', `${startTime}–${endTime} is shorter than one ${duration}-minute slot`);
  }

  const clinicId = input.clinicId ? String(input.clinicId) : null;
  const clinic = clinicId ? ctx.clinicsById.get(clinicId) : null;
  if (clinicId && !clinic) throw new CalendarError('CLINIC_NOT_OWNED', 'That clinic is not one of your active clinics', 403);
  if (types.includes('in-clinic') && !clinic) {
    throw new CalendarError('VALIDATION', 'In-clinic hours need one of your clinics');
  }
  // Both halves of a "both" use the same zone, so 10:00 is one moment.
  const tz = safeZone((clinic && clinic.timezone) || ctx.doctorTz);

  const pieces = [];
  if (split) for (let cur = start; cur + duration <= end; cur += duration) pieces.push([cur, cur + duration]);
  else pieces.push([start, end]);
  if (pieces.length * types.length > MAX_ONE_OFF_SLOTS) {
    throw new CalendarError('VALIDATION', `That would create more than ${MAX_ONE_OFF_SLOTS} slots`);
  }

  const candidates = [];
  const skipped = [];
  for (const [s, e] of pieces) {
    const from = fromMinutes(s);
    const to = fromMinutes(e);
    const startUtc = localToUtc(date, from, tz);
    const endUtc = localToUtc(date, to, tz);
    for (const type of types) {
      if (!startUtc || !endUtc || startUtc <= ctx.bookableFrom) {
        skipped.push({ type, startTime: from, endTime: to, reason: 'PAST_OR_TOO_SOON' });
        continue;
      }
      candidates.push({
        doctorId: ctx.doctorId,
        clinicId: type === 'in-clinic' ? clinic._id : null,
        date: localToUtc(date, '00:00', tz),
        dateKey: date,
        startTime: from,
        endTime: to,
        startUtc,
        endUtc,
        clinicTimezone: tz,
        type,
        status: 'available',
        source: 'manual',
        blockedBy: null,
        heldBy: null,
        maxPatients,
        bookedCount: 0,
      });
    }
  }

  return { candidates, skipped, unusedMinutes: split ? (end - start) % duration : 0 };
}

/** Add one-off hours for a date. */
async function createOneOffSlots(doctor, input, tz, now = new Date()) {
  const zone = safeZone(tz);
  const today = todayKey(zone);
  if (isDateKey(input && input.date)) {
    if (input.date < today) throw new CalendarError('VALIDATION', 'That date has passed');
    if (daysBetween(today, input.date) > 365) {
      throw new CalendarError('VALIDATION', 'Hours can be added at most a year ahead');
    }
    if (awayDayKeys(doctor, zone).has(input.date)) {
      throw new CalendarError('DAY_IN_TIME_OFF', 'You have time off on that day. Remove it first to add hours.', 409);
    }
  }

  const clinics = await Clinic.find({ doctorId: doctor._id, isActive: { $ne: false } })
    .select('_id name address timezone')
    .lean();
  const clinicsById = new Map(clinics.map((c) => [String(c._id), c]));

  const { candidates, skipped, unusedMinutes } = planOneOffSlots(input, {
    doctorId: doctor._id,
    clinicsById,
    doctorTz: zone,
    slotDuration: slotMinutesFor(doctor),
    bookableFrom: slotService.bookableFrom(),
  });

  let docs = [];
  if (candidates.length) {
    let minStart = candidates[0].startUtc;
    let maxEnd = candidates[0].endUtc;
    for (const c of candidates) {
      if (c.startUtc < minStart) minStart = c.startUtc;
      if (c.endUtc > maxEnd) maxEnd = c.endUtc;
    }
    const existing = await Slot.find({ doctorId: doctor._id, startUtc: { $lt: maxEnd }, endUtc: { $gt: minStart } })
      .select('_id startUtc endUtc type clinicId bookedCount dateKey clinicTimezone')
      .lean();
    const planned = planInserts(candidates, existing);
    docs = planned.docs;
    for (const { slot, reason } of planned.skipped) {
      skipped.push({ type: slot.type, startTime: slot.startTime, endTime: slot.endTime, reason });
    }
  }

  if (!docs.length) {
    throw new CalendarError('NOTHING_CREATED', 'None of those times could be added.', 409, { skipped, unusedMinutes });
  }

  let created;
  try {
    created = await Slot.insertMany(docs, { ordered: false });
  } catch (err) {
    if (!err.writeErrors && err.code !== 11000) throw err;
    // A duplicate raced in; report what actually exists now.
    created = await Slot.find({
      doctorId: doctor._id,
      source: 'manual',
      startUtc: { $in: docs.map((d) => d.startUtc) },
    }).lean();
  }

  const clinicsAll = await clinicMap(doctor._id);
  const items = created.map((s) =>
    toDoctorSlot(typeof s.toObject === 'function' ? s.toObject() : s, [], clinicsAll, null, now, input.date)
  );

  return {
    date: input.date,
    created: items,
    skipped,
    summary: { created: items.length, skipped: skipped.length },
    unusedMinutes,
  };
}

/**
 * Reopen closed slots matching `filter`, putting each back to what its
 * bookings say — 'booked' when full, otherwise 'available'. Two conditional
 * updates rather than an update pipeline, so a concurrent booking cannot be
 * overwritten by a stale status.
 */
async function reopenBlockedSlots(filter) {
  const full = await Slot.updateMany(
    { ...filter, status: 'blocked', $expr: { $gte: ['$bookedCount', '$maxPatients'] } },
    { $set: { status: 'booked', blockedBy: null } }
  );
  const open = await Slot.updateMany(
    { ...filter, status: 'blocked', $expr: { $lt: ['$bookedCount', '$maxPatients'] } },
    { $set: { status: 'available', blockedBy: null } }
  );
  return (full.modifiedCount || 0) + (open.modifiedCount || 0);
}

/** Put overlap holds right after slots reopen. */
async function rehold(slotIds) {
  if (!slotIds.length) return 0;
  const slots = await Slot.find({ _id: { $in: slotIds } }).lean();
  let held = 0;
  for (const s of slots) {
    if (s.bookedCount > 0) await slotService.holdOverlapping(s);
    else if (s.status === 'available' && (await slotService.holdIfEngaged(s))) held += 1;
  }
  return held;
}

async function slotItem(doctor, slotId, now) {
  const slot = await Slot.findOne({ _id: slotId, doctorId: doctor._id }).select(SLOT_FIELDS).lean();
  if (!slot) throw new CalendarError('NOT_FOUND', 'Slot not found', 404);
  const [bySlot, clinicsById] = await Promise.all([appointmentsBySlot([slot._id]), clinicMap(doctor._id)]);
  return toDoctorSlot(slot, bySlot.get(String(slot._id)) || [], clinicsById, null, now);
}

/** Close or reopen one slot. `action` is the only field accepted. */
async function setSlotBlocked(doctor, slotId, body = {}, now = new Date()) {
  const unknown = Object.keys(body).filter((k) => k !== 'action');
  if (unknown.length) {
    throw new CalendarError('UNKNOWN_FIELDS', `Only "action" can be changed here (got ${unknown.join(', ')})`);
  }
  const { action } = body;
  if (action !== 'block' && action !== 'unblock') {
    throw new CalendarError('VALIDATION', 'action must be "block" or "unblock"');
  }

  const current = await Slot.findOne({ _id: slotId, doctorId: doctor._id }).select(SLOT_FIELDS).lean();
  if (!current) throw new CalendarError('NOT_FOUND', 'Slot not found', 404);
  if (current.startUtc && new Date(current.startUtc) <= now) {
    throw new CalendarError('SLOT_PAST', 'This slot has already started', 409);
  }

  if (action === 'block') {
    if (current.status !== 'blocked') {
      const res = await Slot.updateOne(
        {
          _id: current._id,
          doctorId: doctor._id,
          status: { $in: ['available', 'held'] },
          $expr: { $lt: ['$bookedCount', '$maxPatients'] },
        },
        { $set: { status: 'blocked', blockedBy: 'doctor', heldBy: null } }
      );
      if (!res.modifiedCount) {
        throw new CalendarError('SLOT_FULLY_BOOKED', 'This slot is fully booked; cancel the appointment to free it', 409);
      }
      // ------------------------------------------------------------------
      // CLOSING A SLOT CLOSES THE INSTANT, NOT ONE DOCUMENT.
      //
      // A doctor offering 10:00 both in clinic and over video has TWO slot
      // documents at that instant — the unique index is keyed on `type`
      // precisely to allow it. Booking has always taken the twins off the
      // market (claimSlot → holdOverlapping); closing wrote this single _id
      // and stopped, so the video twin stayed `available` and patients could
      // still book an hour the doctor had explicitly closed. In-clinic never
      // showed the bug because it has no same-type twin.
      // ------------------------------------------------------------------
      await slotService.holdOverlapping(current);
    }
  } else if (current.status === 'blocked') {
    if (current.blockedBy === 'time_off') {
      throw new CalendarError('BLOCKED_BY_TIME_OFF', 'This day is in your time off. Remove the time off to reopen it.', 409);
    }
    if (current.blockedBy === 'template') {
      throw new CalendarError('NOT_IN_WEEKLY_HOURS', 'This time is no longer in your weekly hours.', 409);
    }
    await reopenBlockedSlots({ _id: current._id, doctorId: doctor._id });
    // Give the twins back, now that this slot is open again. Ordered after the
    // reopen on purpose: releaseHolds re-checks for an overlapping engagement,
    // and this slot would still count as one if it were still blocked. A twin
    // that overlaps some OTHER closure or booking stays held.
    await slotService.releaseHolds(current);
    await rehold([current._id]);
  }

  return slotItem(doctor, current._id, now);
}

/** Delete a hand-made slot, or close a weekly-hours one. Never one with a booking. */
async function deleteSlot(doctor, slotId) {
  const slot = await Slot.findOne({ _id: slotId, doctorId: doctor._id }).select('_id bookedCount').lean();
  if (!slot) throw new CalendarError('NOT_FOUND', 'Slot not found', 404);
  const active = await Appointment.find({ slotId: slot._id, status: { $in: ACTIVE_STATUSES } })
    .select('_id status patientInfo.name')
    .lean();
  // bookedCount alone missed a group slot's pending requests and any
  // appointment left behind by older code; either would be orphaned.
  if (slot.bookedCount > 0 || active.length) {
    throw new CalendarError('SLOT_HAS_BOOKINGS', 'This slot has appointments. Cancel them first.', 409, {
      appointments: active.map((a) => ({
        id: String(a._id),
        status: a.status,
        patientName: (a.patientInfo && a.patientInfo.name) || 'Patient',
      })),
    });
  }
  const outcome = await slotService.deleteDoctorSlot(slot._id, doctor._id);
  return { outcome, slotId: String(slot._id) };
}

function dayFilter(doctor, date, tz, now) {
  const range = paddedRange(date, date, tz);
  const zone = safeZone(tz);
  // A slot that predates the dateKey backfill has `dateKey: null` and fails the
  // exact bound, so "Close day" skipped it — while getDayView SHOWS it to the
  // doctor and getGroupedSlots SERVES it to patients. Both of those already
  // carry this fallback; this filter did not, so the doctor closed a day and a
  // patient booked into it anyway.
  const legacy = {
    $gte: localToUtc(date, '00:00', zone),
    $lt: localToUtc(addDays(date, 1, zone), '00:00', zone),
  };
  return {
    doctorId: doctor._id,
    startUtc: { $gt: now },
    $or: [
      { dateKey: range.dateKey, startUtc: range.startUtc },
      { dateKey: null, startUtc: legacy },
    ],
  };
}

function assertBookableDay(date, tz) {
  if (!isDateKey(date)) throw new CalendarError('VALIDATION', 'date must be YYYY-MM-DD');
  const today = todayKey(tz);
  if (date < today) throw new CalendarError('VALIDATION', 'That date has passed');
}

/** Close every remaining slot on a day. Bookings stay; nothing is cancelled. */
async function blockDay(doctor, date, tz, now = new Date()) {
  const zone = safeZone(tz);
  assertBookableDay(date, zone);
  const filter = dayFilter(doctor, date, zone, now);

  const bookedSlots = await Slot.find({ ...filter, bookedCount: { $gt: 0 }, status: { $ne: 'blocked' } })
    .select('_id')
    .lean();
  const res = await Slot.updateMany(
    { ...filter, status: { $in: ['available', 'held', 'booked'] } },
    { $set: { status: 'blocked', blockedBy: 'doctor', heldBy: null } }
  );

  const bySlot = await appointmentsBySlot(bookedSlots.map((s) => s._id));
  const bookedKept = [];
  for (const list of bySlot.values()) {
    for (const a of list) {
      if (!ACTIVE_STATUSES.includes(a.status)) continue;
      bookedKept.push({
        appointmentId: String(a._id),
        status: a.status,
        patientName: (a.patientId && a.patientId.fullName) || (a.patientInfo && a.patientInfo.name) || 'Patient',
      });
    }
  }
  return { date, blocked: res.modifiedCount || 0, bookedKept };
}

/** Reopen what the doctor closed on a day (not time off, not old weekly hours). */
async function unblockDay(doctor, date, tz, now = new Date()) {
  const zone = safeZone(tz);
  assertBookableDay(date, zone);
  if (awayDayKeys(doctor, zone).has(date)) {
    throw new CalendarError('DAY_IN_TIME_OFF', 'This day is in your time off. Remove the time off to reopen it.', 409);
  }
  const filter = { ...dayFilter(doctor, date, zone, now), status: 'blocked', blockedBy: { $in: ['doctor', null] } };
  const ids = (await Slot.find(filter).select('_id').lean()).map((s) => s._id);
  if (!ids.length) return { date, unblocked: 0, held: 0 };
  const unblocked = await reopenBlockedSlots({ _id: { $in: ids } });
  const held = await rehold(ids);
  return { date, unblocked, held };
}

module.exports = {
  CalendarError,
  deriveSlotState,
  planOneOffSlots,
  toDoctorSlot,
  getDayView,
  getCalendarSummary,
  createOneOffSlots,
  reopenBlockedSlots,
  setSlotBlocked,
  deleteSlot,
  blockDay,
  unblockDay,
};
