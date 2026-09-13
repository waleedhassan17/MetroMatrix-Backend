const mongoose = require('mongoose');
const Slot = require('../models/Slot');
const {
  DEFAULT_TIMEZONE,
  HHMM,
  safeZone,
  localToUtc,
  todayKey,
  addDays,
  toMinutes,
} = require('../../../utils/time');

/**
 * How far ahead of "now" a slot must start to be bookable.
 *
 * Zero would let a patient book a slot that begins this second, which neither
 * side can honour. Configurable so a clinic that needs preparation time can
 * lengthen it.
 */
const BOOKING_LEAD_MINUTES = Number(process.env.BOOKING_LEAD_MINUTES || 15);

/** The earliest instant a slot may start and still be offered. */
const bookableFrom = () => new Date(Date.now() + BOOKING_LEAD_MINUTES * 60 * 1000);

/**
 * Time-of-day buckets for grouping slots.
 */
const TIME_BUCKETS = {
  morning: { label: 'Morning', start: '06:00', end: '12:00' },
  afternoon: { label: 'Afternoon', start: '12:00', end: '17:00' },
  evening: { label: 'Evening', start: '17:00', end: '22:00' },
};

/**
 * Determine which time bucket a slot's startTime falls into.
 */
const getTimeBucket = (startTime) => {
  if (startTime >= '06:00' && startTime < '12:00') return 'morning';
  if (startTime >= '12:00' && startTime < '17:00') return 'afternoon';
  if (startTime >= '17:00' && startTime < '22:00') return 'evening';
  return 'other';
};

/**
 * Get available slots for a doctor on a specific date, grouped by time of day.
 * @param {string} doctorId
 * @param {Object} filters - { date (YYYY-MM-DD, required), type, clinicId }
 */
const getGroupedSlots = async (doctorId, filters = {}) => {
  const { date, type, clinicId } = filters;

  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const query = {
    doctorId: new mongoose.Types.ObjectId(doctorId),
    date: { $gte: startOfDay, $lte: endOfDay },
    status: 'available',
    // ------------------------------------------------------------------
    // ONLY SLOTS THAT ARE STILL IN THE FUTURE.
    //
    // There was no time filter of any kind here — the query bounded the DAY
    // and nothing else. So at 18:00 a patient was still offered this
    // morning's 09:00 slot, and could book it. Past dates returned their
    // stale slots in full. This is the single most visible correctness bug
    // in patient discovery.
    //
    // Compared on startUtc, the real instant, not the wall-clock string. The
    // $or keeps slots that predate the backfill visible rather than making
    // them vanish; they simply cannot be time-filtered until backfilled.
    // ------------------------------------------------------------------
    $or: [{ startUtc: { $gt: bookableFrom() } }, { startUtc: null }],
  };

  if (type) query.type = type;
  if (clinicId) query.clinicId = new mongoose.Types.ObjectId(clinicId);

  const slots = await Slot.find(query)
    .populate('clinicId', 'name address city area type timezone')
    .sort({ startUtc: 1, startTime: 1 })
    .lean();

  // GROUPED BY CLINIC, not by time of day.
  //
  // The old shape bucketed into morning/afternoon/evening and returned the
  // clinic only as a per-slot field, so a patient could not see "these are the
  // Gulberg times, these are the DHA times" — the thing that actually matters
  // when a doctor works several locations. Worse, any slot outside 06:00–22:00
  // fell into a bucket the response did not include and was SILENTLY DROPPED;
  // an early or late clinic simply had no availability as far as patients knew.
  const groups = new Map();

  for (const slot of slots) {
    // A full multi-patient slot is not bookable. This was computed as
    // `isAvailable` and then returned anyway, so unbookable slots were shown.
    if (slot.bookedCount >= slot.maxPatients) continue;

    const clinic = slot.clinicId || null;
    const key = clinic ? String(clinic._id) : 'online';

    if (!groups.has(key)) {
      groups.set(key, {
        clinic: clinic
          ? {
              id: String(clinic._id),
              name: clinic.name,
              address: clinic.address,
              city: clinic.city,
              area: clinic.area,
              type: clinic.type || 'physical',
              timezone: clinic.timezone || DEFAULT_TIMEZONE,
            }
          : { id: null, name: 'Online consultation', type: 'online', timezone: DEFAULT_TIMEZONE },
        slots: [],
      });
    }

    groups.get(key).slots.push({
      slotId: slot._id,
      startTime: slot.startTime,
      endTime: slot.endTime,
      // The instant, so the client can render in the viewer's own zone.
      startUtc: slot.startUtc || null,
      endUtc: slot.endUtc || null,
      clinicTimezone: slot.clinicTimezone || DEFAULT_TIMEZONE,
      type: slot.type,
      isAvailable: true,
      clinic: clinic || null,
    });
  }

  return Array.from(groups.values());
};

/**
 * Which of these dates actually have bookable slots — and how many, per clinic.
 *
 * This is what lets a patient booking on Monday for Saturday see at a glance
 * which days are worth tapping. Without it the date strip is fourteen
 * indistinguishable chips, most of them empty, and finding availability is
 * guesswork. Marham solves the same problem with "Available from <date>".
 *
 * One aggregation over an indexed range, not N day-queries.
 */
const getAvailabilitySummary = async (doctorId, { fromUtc, toUtc, type, clinicId } = {}) => {
  const match = {
    doctorId: new mongoose.Types.ObjectId(doctorId),
    status: 'available',
    startUtc: { $gt: bookableFrom(), $lte: toUtc },
    $expr: { $lt: ['$bookedCount', '$maxPatients'] },
  };
  if (fromUtc && fromUtc > match.startUtc.$gt) match.startUtc.$gt = fromUtc;
  if (type) match.type = type;
  if (clinicId) match.clinicId = new mongoose.Types.ObjectId(clinicId);

  const rows = await Slot.aggregate([
    { $match: match },
    {
      $group: {
        // Group by the calendar day AT THE CLINIC, so a late-evening slot is
        // not pushed onto the next day by a UTC boundary.
        _id: {
          date: {
            $dateToString: {
              date: '$startUtc',
              format: '%Y-%m-%d',
              timezone: { $ifNull: ['$clinicTimezone', DEFAULT_TIMEZONE] },
            },
          },
          clinicId: '$clinicId',
        },
        count: { $sum: 1 },
        earliest: { $min: '$startUtc' },
      },
    },
    { $sort: { '_id.date': 1, earliest: 1 } },
  ]);

  const byDate = new Map();
  for (const row of rows) {
    const { date, clinicId: cid } = row._id;
    if (!byDate.has(date)) byDate.set(date, { date, total: 0, earliest: row.earliest, clinics: [] });
    const entry = byDate.get(date);
    entry.total += row.count;
    if (row.earliest < entry.earliest) entry.earliest = row.earliest;
    entry.clinics.push({ clinicId: cid ? String(cid) : null, count: row.count });
  }

  return Array.from(byDate.values());
};

/**
 * The earliest moment this doctor can next be seen, with where.
 *
 * Drives the "Available today" / "Available from Sat, 5 Sep" label on doctor
 * cards. Returns null when the doctor has nothing in the window — which is
 * itself worth showing, rather than presenting a doctor as bookable and
 * dead-ending the patient on an empty calendar.
 */
const getNextAvailable = async (doctorId, { toUtc, type } = {}) => {
  const query = {
    doctorId: new mongoose.Types.ObjectId(doctorId),
    status: 'available',
    startUtc: { $gt: bookableFrom(), $lte: toUtc },
    $expr: { $lt: ['$bookedCount', '$maxPatients'] },
  };
  if (type) query.type = type;

  const slot = await Slot.findOne(query)
    .sort({ startUtc: 1 })
    .populate('clinicId', 'name address city type timezone')
    .lean();

  if (!slot) return null;
  return {
    slotId: String(slot._id),
    startUtc: slot.startUtc,
    startTime: slot.startTime,
    clinicTimezone: slot.clinicTimezone || DEFAULT_TIMEZONE,
    type: slot.type,
    clinic: slot.clinicId || null,
  };
};

/**
 * Find available slots with flat list (no grouping).
 */
const findAvailableSlots = async (doctorId, filters = {}) => {
  const { date, type } = filters;

  const query = {
    doctorId: new mongoose.Types.ObjectId(doctorId),
    status: 'available',
  };

  if (date) {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);
    query.date = { $gte: startOfDay, $lte: endOfDay };
  } else {
    query.date = { $gte: new Date() };
  }

  if (type) query.type = type;

  return Slot.find(query)
    .populate('clinicId', 'name address')
    .sort({ date: 1, startTime: 1 });
};

/**
 * Create multiple slots.
 */
const createSlots = async (slotsData) => {
  return Slot.insertMany(slotsData);
};

/**
 * Update a single slot (doctor-owned).
 */
const updateSlot = async (id, doctorId, data) => {
  return Slot.findOneAndUpdate(
    { _id: id, doctorId },
    data,
    { new: true, runValidators: true }
  );
};

/**
 * Delete a slot only if it isn't booked (doctor-owned).
 */
const deleteSlot = async (id, doctorId) => {
  return Slot.findOneAndDelete({ _id: id, doctorId, status: { $ne: 'booked' } });
};

/**
 * Read-only check that a slot looks bookable, for pre-flight validation and
 * error messages.
 *
 * NOT the concurrency guard — see claimSlot. Two callers can both pass this.
 */
const validateSlotForBooking = async (slotId, doctorId, session = null) => {
  const slot = await Slot.findOne({
    _id: slotId,
    doctorId,
    status: 'available',
  }).session(session);

  if (!slot) return null;
  if (slot.bookedCount >= slot.maxPatients) return null;
  // A slot that has already started cannot be booked. Nothing checked this,
  // so a patient could book this morning's slot at 18:00.
  if (slot.startUtc && slot.startUtc <= bookableFrom()) return null;
  return slot;
};

// ============================================================================
// ONE DOCTOR, ONE PLACE AT A TIME.
//
// Slots are separate documents per type and per clinic, so a doctor who offers
// 10:00 as both a video consult and an in-clinic visit — or at both clinics —
// has several slots sharing one instant. The capacity guard in claimSlot only
// ever looked at the slot being claimed, so booking the video slot left the
// in-clinic slot at the same moment fully bookable. Two patients, one doctor,
// same minute.
//
// So a booking now HOLDS every slot of the same doctor whose time overlaps it,
// and releasing that booking gives them back. Overlap is the half-open
// interval test on the real instants: a 10:00–10:30 slot does not collide with
// one starting at 10:30.
// ============================================================================

/** Every OTHER slot of this doctor whose time range intersects [startUtc, endUtc). */
const overlapFilter = (doctorId, startUtc, endUtc, excludeId) => ({
  doctorId,
  _id: { $ne: excludeId },
  startUtc: { $lt: endUtc },
  endUtc: { $gt: startUtc },
});

/** True when an overlapping slot of this doctor already carries a booking. */
const hasOverlappingBooking = async (slot, session = null) => {
  if (!slot.startUtc || !slot.endUtc) return false;
  const clash = await Slot.findOne({
    ...overlapFilter(slot.doctorId, slot.startUtc, slot.endUtc, slot._id),
    bookedCount: { $gt: 0 },
  })
    .select('_id')
    .session(session)
    .lean();
  return clash ? clash._id : false;
};

/**
 * Take every open, unbooked overlapping slot off the market.
 *
 * Only 'available' slots are touched: a doctor's own 'blocked' slot stays
 * blocked, and one already held by another booking keeps that holder.
 */
const holdOverlapping = async (slot, session = null) => {
  if (!slot.startUtc || !slot.endUtc) return 0;
  const res = await Slot.updateMany(
    {
      ...overlapFilter(slot.doctorId, slot.startUtc, slot.endUtc, slot._id),
      status: 'available',
      bookedCount: 0,
    },
    { $set: { status: 'held', heldBy: slot._id } },
    { session }
  );
  return res.modifiedCount || 0;
};

/**
 * Give back the slots a booking was holding — but only those nothing else still
 * holds. A slot can overlap two bookings (10:15–10:45 against both 10:00 and
 * 10:30); releasing one of them must re-point it at the other, not re-open it.
 */
const releaseHolds = async (slot, session = null) => {
  const held = await Slot.find({ heldBy: slot._id, status: 'held' })
    .select('_id doctorId startUtc endUtc')
    .session(session)
    .lean();

  for (const h of held) {
    const stillHeldBy = await hasOverlappingBooking(h, session);
    await Slot.updateOne(
      { _id: h._id, status: 'held' },
      stillHeldBy
        ? { $set: { heldBy: stillHeldBy } }
        : { $set: { status: 'available', heldBy: null } },
      { session }
    );
  }
  return held.length;
};

/**
 * Hold a single slot if it overlaps an existing booking. For slots that come
 * into being ALREADY overlapping one — a doctor creating or unblocking a slot
 * at a time they are already booked.
 */
const holdIfEngaged = async (slot, session = null) => {
  if (slot.status !== 'available' || slot.bookedCount > 0) return false;
  const holder = await hasOverlappingBooking(slot, session);
  if (!holder) return false;
  await Slot.updateOne(
    { _id: slot._id, status: 'available', bookedCount: 0 },
    { $set: { status: 'held', heldBy: holder } },
    { session }
  );
  return true;
};

/**
 * CLAIM a slot: the atomic guard that actually prevents double-booking.
 *
 * WHAT THIS REPLACES
 * ------------------
 * Booking was `findOne` to check availability, then `findById` → `+= 1` →
 * `save()` to take it. A read, a decision in JavaScript, then a blind write.
 * Two concurrent bookings both read bookedCount: 0 and both wrote 1, and the
 * only thing preventing a genuine double-book was WiredTiger noticing two
 * transactions touching the same document — which surfaces as a raw
 * WriteConflict, i.e. an unhandled 500 for the losing patient, with no retry.
 *
 * This is a single conditional update. The filter carries the invariant
 * (`bookedCount < maxPatients`), so the database decides the winner and the
 * loser gets null. There is no window between the check and the write because
 * there is no separate check.
 *
 * Returns the updated slot, or null when the slot was already taken, blocked,
 * in the past, or does not belong to this doctor — the caller translates null
 * into a clean 409 SLOT_TAKEN rather than a 500.
 */
const claimSlot = async (slotId, doctorId, session = null) => {
  const claimed = await Slot.findOneAndUpdate(
    {
      _id: slotId,
      doctorId,
      status: 'available',
      // The capacity invariant, evaluated by the database against the document
      // as it exists at write time — not against a value read moments earlier.
      $expr: { $lt: ['$bookedCount', '$maxPatients'] },
      // Never claim a slot that has already begun. `$or` keeps pre-backfill
      // slots (startUtc: null) claimable rather than freezing bookings.
      $or: [{ startUtc: { $gt: bookableFrom() } }, { startUtc: null }],
    },
    { $inc: { bookedCount: 1 } },
    { new: true, session }
  );

  if (!claimed) return null;

  // The FIRST booking on this slot commits the doctor to its time, so it must
  // not collide with a booking on an overlapping slot, and it takes those
  // overlapping slots off the market. A group slot's later bookings add
  // nothing new: the doctor was already committed by the first.
  if (claimed.bookedCount === 1) {
    // A concurrent claim on an overlapping slot, or an overlapping slot that
    // was booked before this one was created. Either way the doctor is taken.
    if (await hasOverlappingBooking(claimed, session)) {
      // Inside a transaction the caller aborts and this never lands. Outside
      // one, put the count back ourselves rather than leak a phantom booking.
      if (!session) {
        await Slot.updateOne({ _id: claimed._id, bookedCount: { $gt: 0 } }, { $inc: { bookedCount: -1 } });
      }
      return null;
    }
    await holdOverlapping(claimed, session);
  }

  // Flip to 'booked' once full. Conditional on the count so a concurrent
  // release cannot be overwritten by a stale status write.
  if (claimed.bookedCount >= claimed.maxPatients && claimed.status !== 'booked') {
    await Slot.updateOne(
      { _id: claimed._id, $expr: { $gte: ['$bookedCount', '$maxPatients'] } },
      { $set: { status: 'booked' } },
      { session }
    );
    claimed.status = 'booked';
  }

  return claimed;
};

/**
 * @deprecated Use claimSlot — this cannot be made safe.
 * Retained only so any caller still on it keeps compiling; it now delegates.
 */
const incrementBookedCount = async (slotId, session = null) => {
  const slot = await Slot.findById(slotId).session(session).lean();
  if (!slot) return null;
  return claimSlot(slotId, slot.doctorId, session);
};

/**
 * RELEASE a slot after a cancellation. The mirror of claimSlot.
 *
 * BLOCK-AWARE, and that is the fix. There were two divergent implementations:
 * the doctor's cancel guarded `status !== 'blocked'`, while the patient's set
 * `status = 'available'` unconditionally — so a patient cancelling an
 * appointment on a day the doctor had deliberately blocked (holiday, absence)
 * silently re-opened that slot for booking. One implementation, and it keeps a
 * blocked slot blocked.
 *
 * Atomic for the same reason as claimSlot: `$inc` with a floor condition rather
 * than read-modify-write, so a concurrent claim cannot be lost.
 */
const releaseSlot = async (slotId, session = null) => {
  const released = await Slot.findOneAndUpdate(
    { _id: slotId, bookedCount: { $gt: 0 } },
    { $inc: { bookedCount: -1 } },
    { new: true, session }
  );

  // Already at zero (a double-cancel, or availability edits that cancelled the
  // appointment without decrementing) — nothing to give back.
  if (!released) return null;

  if (released.bookedCount < released.maxPatients && released.status === 'booked') {
    await Slot.updateOne(
      { _id: released._id, status: 'booked', $expr: { $lt: ['$bookedCount', '$maxPatients'] } },
      { $set: { status: 'available' } },
      { session }
    );
    released.status = 'available';
  }

  // The last booking is gone, so the doctor is free at this time again — hand
  // back whatever this slot was holding. (A group slot with bookings left
  // still commits the doctor, so its holds stay.)
  if (released.bookedCount === 0) {
    await releaseHolds(released, session);
  }

  return released;
};

/** @deprecated Use releaseSlot — this un-blocked doctor-blocked slots. */
const decrementBookedCount = async (slotId, session = null) => releaseSlot(slotId, session);

// ============================================================================
// DOCTOR-AUTHORED SLOTS
//
// The previous write path was `Slot.insertMany(req.body.slots)` and
// `findOneAndUpdate(id, req.body)`. That had three consequences:
//
//   · INVISIBLE TO PATIENTS. startUtc was never computed, and the patient date
//     strip and "next available" both filter on it — so a date a doctor had
//     just filled still showed as empty to every patient.
//   · UNSAFE. The whole body was written, so a doctor could set bookedCount: 0
//     on a booked slot, move a booked appointment's time out from under the
//     patient, or attach another doctor's clinic.
//   · NO "BOTH". A slot has exactly one type, so the app quietly saved "both"
//     as in-clinic and no video slot ever existed.
//
// Everything below builds the SAME document shape as the weekly generator
// (availabilityService.expandDay), so a hand-made slot and a generated one are
// indistinguishable to every reader.
// ============================================================================

class SlotInputError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const MAX_PATIENTS_CAP = 10;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_TYPES = ['video', 'in-clinic'];

/**
 * The doctor's clinics, keyed by id, for ownership checks and timezones.
 * Deleted (inactive) clinics are excluded: a doctor must not be able to publish
 * new hours at a clinic they closed.
 */
const clinicsFor = async (doctorId) => {
  const Clinic = require('../models/Clinic');
  const clinics = await Clinic.find({ doctorId, isActive: { $ne: false } })
    .select('_id name address timezone isActive')
    .lean();
  return new Map(clinics.map((c) => [String(c._id), c]));
};

/**
 * Turn one requested slot into one or two slot documents ("both" → a video slot
 * and an in-clinic slot at the same time; booking either holds the other).
 * Throws SlotInputError naming exactly what is wrong.
 *
 * @param {string} [defaultTz] zone for a video slot with no clinic — the
 *   doctor's, so "19:00" means the same moment the doctor sees on their calendar.
 */
const buildSlotDocs = (doctorId, input, clinicsById, label, defaultTz = DEFAULT_TIMEZONE) => {
  const where = label ? `${label}: ` : '';
  const date = String((input && input.date) || '').slice(0, 10);
  const startTime = input && input.startTime;
  const endTime = input && input.endTime;
  const requested = input && input.type;

  if (!DATE_KEY.test(date)) throw new SlotInputError(`${where}date must be YYYY-MM-DD`);
  if (!HHMM.test(startTime || '') || !HHMM.test(endTime || '')) {
    throw new SlotInputError(`${where}startTime and endTime must be HH:MM`);
  }
  if (toMinutes(endTime) <= toMinutes(startTime)) {
    throw new SlotInputError(`${where}endTime must be after startTime`);
  }

  const types = requested === 'both' ? ['video', 'in-clinic'] : [requested];
  if (!types.every((t) => SLOT_TYPES.includes(t))) {
    throw new SlotInputError(`${where}type must be video, in-clinic or both`);
  }

  const clinicId = input && input.clinicId ? String(input.clinicId) : null;
  const clinic = clinicId ? clinicsById.get(clinicId) : null;
  if (clinicId && !clinic) {
    // Not "not found" — it may well exist, just not as this doctor's.
    throw new SlotInputError(`${where}that clinic is not one of yours`, 403);
  }
  if (types.includes('in-clinic') && !clinic) {
    throw new SlotInputError(`${where}an in-clinic slot needs one of your clinics`);
  }

  const maxPatients = input.maxPatients == null ? 1 : Number(input.maxPatients);
  if (!Number.isInteger(maxPatients) || maxPatients < 1 || maxPatients > MAX_PATIENTS_CAP) {
    throw new SlotInputError(`${where}maxPatients must be a whole number from 1 to ${MAX_PATIENTS_CAP}`);
  }

  // A video consult has no location; it still takes the clinic's zone when one
  // is given, so "10:00" means the same moment for both halves of a "both".
  const tz = safeZone((clinic && clinic.timezone) || defaultTz);
  const startUtc = localToUtc(date, startTime, tz);
  const endUtc = localToUtc(date, endTime, tz);
  if (!startUtc || !endUtc) throw new SlotInputError(`${where}that date or time does not exist`);
  if (startUtc <= bookableFrom()) {
    throw new SlotInputError(`${where}${date} ${startTime} is in the past or too soon to book`);
  }

  return types.map((type) => ({
    doctorId,
    clinicId: type === 'in-clinic' ? clinic._id : null,
    date: localToUtc(date, '00:00', tz),
    dateKey: date,
    startTime,
    endTime,
    startUtc,
    endUtc,
    clinicTimezone: tz,
    type,
    status: 'available',
    source: 'manual',
    heldBy: null,
    maxPatients,
    bookedCount: 0,
  }));
};

/**
 * The same offering twice: same type, same clinic, overlapping time. That is a
 * genuine mistake, unlike a video slot overlapping an in-clinic one, which is a
 * doctor offering two ways to be seen at 10:00 (held together at booking).
 */
const sameOfferingClash = (doctorId, doc, excludeId = null) =>
  Slot.findOne({
    doctorId,
    type: doc.type,
    clinicId: doc.clinicId,
    startUtc: { $lt: doc.endUtc },
    endUtc: { $gt: doc.startUtc },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  })
    .select('_id startTime endTime type')
    .lean();

const describe = (d) => `${d.type === 'video' ? 'video' : 'in-clinic'} ${d.startTime}–${d.endTime}`;

/** Create slots from a doctor's request. Validates everything before writing anything. */
const createDoctorSlots = async (doctorId, inputs, { defaultTz = DEFAULT_TIMEZONE } = {}) => {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new SlotInputError('slots array is required and must not be empty');
  }
  if (inputs.length > 200) throw new SlotInputError('At most 200 slots per request');

  const clinicsById = await clinicsFor(doctorId);
  const docs = inputs.flatMap((input, i) =>
    buildSlotDocs(doctorId, input, clinicsById, inputs.length > 1 ? `Slot ${i + 1}` : '', defaultTz)
  );

  // Clashes inside the request itself, then against what is already stored.
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      const a = docs[i];
      const b = docs[j];
      if (
        a.type === b.type &&
        String(a.clinicId) === String(b.clinicId) &&
        a.startUtc < b.endUtc &&
        b.startUtc < a.endUtc
      ) {
        throw new SlotInputError(`${describe(a)} and ${describe(b)} overlap`, 409);
      }
    }
  }
  for (const d of docs) {
    const clash = await sameOfferingClash(doctorId, d);
    if (clash) {
      throw new SlotInputError(
        `That overlaps your existing ${describe(clash)} slot`,
        409
      );
    }
  }

  const created = await Slot.insertMany(docs);

  // A slot created at a time the doctor is already booked goes straight to held.
  for (const slot of created) await holdIfEngaged(slot);

  return created.map((s) => String(s._id));
};

/**
 * Edit a slot the doctor owns. Only while nobody has booked it and no booking
 * is holding it — changing a booked slot would move a patient's appointment
 * without telling them.
 */
const updateDoctorSlot = async (slotId, doctorId, body = {}) => {
  const slot = await Slot.findOne({ _id: slotId, doctorId });
  if (!slot) throw new SlotInputError('Slot not found', 404);
  if (slot.bookedCount > 0) {
    throw new SlotInputError('This slot has a booking and can no longer be changed', 409);
  }
  if (slot.status === 'held') {
    throw new SlotInputError('This slot overlaps a booked appointment and cannot be changed', 409);
  }

  // Open/close without touching the time. Only the two states a doctor owns.
  if (body.status !== undefined && !['available', 'blocked'].includes(body.status)) {
    throw new SlotInputError('status can only be set to available or blocked');
  }

  const timingChanged = ['date', 'startTime', 'endTime', 'type', 'clinicId', 'maxPatients'].some(
    (k) => body[k] !== undefined
  );

  if (timingChanged) {
    // A weekly-hours slot cannot be moved: the nightly horizon job re-creates
    // the template's original time, so a moved slot came back as a duplicate
    // offering. Close it and add one-off hours instead.
    if (slot.source === 'template') {
      throw new SlotInputError(
        'This time comes from your weekly hours. Close it and add one-off hours instead of moving it.',
        409
      );
    }
    if (body.type === 'both') {
      throw new SlotInputError('An existing slot has one type; add a second slot for the other');
    }
    const clinicsById = await clinicsFor(doctorId);
    const tz = slot.clinicTimezone || DEFAULT_TIMEZONE;
    // Legacy slots predate startUtc; calling a method on null was a 500.
    const currentDay =
      slot.dateKey ||
      (slot.startUtc
        ? slot.startUtc.toLocaleDateString('en-CA', { timeZone: tz })
        : require('./appointmentTime').inferSlotInstants(slot, tz).dateKey);
    const merged = {
      date: body.date !== undefined ? body.date : currentDay,
      startTime: body.startTime !== undefined ? body.startTime : slot.startTime,
      endTime: body.endTime !== undefined ? body.endTime : slot.endTime,
      type: body.type !== undefined ? body.type : slot.type,
      clinicId: body.clinicId !== undefined ? body.clinicId : slot.clinicId,
      maxPatients: body.maxPatients !== undefined ? body.maxPatients : slot.maxPatients,
    };
    const [doc] = buildSlotDocs(doctorId, merged, clinicsById, '', tz);

    const clash = await sameOfferingClash(doctorId, doc, slot._id);
    if (clash) {
      throw new SlotInputError(`That would overlap your ${describe(clash)} slot`, 409);
    }

    Object.assign(slot, {
      clinicId: doc.clinicId,
      date: doc.date,
      dateKey: doc.dateKey,
      startTime: doc.startTime,
      endTime: doc.endTime,
      startUtc: doc.startUtc,
      endUtc: doc.endUtc,
      clinicTimezone: doc.clinicTimezone,
      type: doc.type,
      maxPatients: doc.maxPatients,
    });
  }

  if (body.status !== undefined) {
    slot.status = body.status;
    // Record who closed it, so lifting time off never reopens it.
    slot.blockedBy = body.status === 'blocked' ? 'doctor' : null;
  }
  await slot.save();

  // Reopened, or moved onto a time the doctor is already booked for.
  if (slot.status === 'available') await holdIfEngaged(slot);

  return slot;
};

/**
 * Delete an unbooked slot the doctor owns.
 *
 * Resolves to 'deleted', or 'closed' for a slot generated from the weekly
 * template: the horizon job re-creates any template slot that is missing, so a
 * real delete would silently come back the next night. Closing it leaves a
 * record the generator de-duplicates against, which is what makes it stick.
 */
const deleteDoctorSlot = async (slotId, doctorId) => {
  const slot = await Slot.findOne({ _id: slotId, doctorId }).select('_id bookedCount source status').lean();
  if (!slot) throw new SlotInputError('Slot not found', 404);
  if (slot.bookedCount > 0) {
    throw new SlotInputError('This slot has a booking; cancel the appointment first', 409);
  }
  if (slot.source === 'template') {
    const res = await Slot.updateOne(
      { _id: slotId, doctorId, bookedCount: 0 },
      { $set: { status: 'blocked', blockedBy: 'doctor', heldBy: null } }
    );
    if (!res.matchedCount) {
      throw new SlotInputError('This slot was just booked and can no longer be removed', 409);
    }
    return 'closed';
  }
  // Conditional on the count, so a patient booking it this instant still wins.
  const res = await Slot.deleteOne({ _id: slotId, doctorId, bookedCount: 0 });
  if (!res.deletedCount) {
    throw new SlotInputError('This slot was just booked and can no longer be deleted', 409);
  }
  return 'deleted';
};

/**
 * A doctor's slots for a day, each with the state the doctor needs to see:
 *   open · requested (a patient asked, awaiting approval) · booked (approved)
 *   · held (overlaps a booking) · blocked (closed by the doctor) · past
 */
const getDoctorSlotsWithState = async (doctorId, { date } = {}) => {
  const Appointment = require('../models/Appointment');
  const clinicsById = await clinicsFor(doctorId);
  const first = [...clinicsById.values()][0];
  const tz = safeZone((first && first.timezone) || DEFAULT_TIMEZONE);

  const dayKey = DATE_KEY.test(date || '') ? date : todayKey(tz);
  const from = localToUtc(dayKey, '00:00', tz);
  const to = localToUtc(addDays(dayKey, 1, tz), '00:00', tz);

  const slots = await Slot.find({
    doctorId,
    // startUtc for everything current; the date range only for legacy rows
    // that predate the backfill and have no instant.
    $or: [{ startUtc: { $gte: from, $lt: to } }, { startUtc: null, date: { $gte: from, $lt: to } }],
  })
    .populate('clinicId', 'name address')
    .sort({ startUtc: 1, startTime: 1 })
    .lean();

  const ids = slots.map((s) => s._id);
  const appointments = ids.length
    ? await Appointment.find({
        slotId: { $in: ids },
        status: { $in: ['pending', 'confirmed', 'completed'] },
      })
        .select('slotId status patientInfo.name type')
        .lean()
    : [];

  const bySlot = new Map();
  for (const a of appointments) {
    const k = String(a.slotId);
    if (!bySlot.has(k)) bySlot.set(k, []);
    bySlot.get(k).push({
      id: String(a._id),
      status: a.status,
      patientName: (a.patientInfo && a.patientInfo.name) || 'Patient',
    });
  }
  const byId = new Map(slots.map((s) => [String(s._id), s]));
  const now = new Date();

  return slots.map((s) => {
    const appts = bySlot.get(String(s._id)) || [];
    const isPast = !!s.startUtc && s.startUtc <= now;

    let state;
    if (appts.some((a) => a.status === 'confirmed' || a.status === 'completed')) state = 'booked';
    else if (appts.some((a) => a.status === 'pending')) state = 'requested';
    else if (s.status === 'held') state = 'held';
    else if (s.status === 'blocked') state = 'blocked';
    else if (isPast) state = 'past';
    else state = 'open';

    const holder = s.heldBy ? byId.get(String(s.heldBy)) : null;

    return {
      id: String(s._id),
      date: dayKey,
      startTime: s.startTime,
      endTime: s.endTime,
      startUtc: s.startUtc,
      endUtc: s.endUtc,
      type: s.type,
      clinic: s.clinicId
        ? { id: String(s.clinicId._id), name: s.clinicId.name, address: s.clinicId.address }
        : null,
      status: s.status,
      state,
      isPast,
      maxPatients: s.maxPatients,
      bookedCount: s.bookedCount,
      appointments: appts,
      heldBy: holder
        ? { id: String(holder._id), type: holder.type, startTime: holder.startTime, endTime: holder.endTime }
        : null,
      canEdit: !isPast && s.bookedCount === 0 && (state === 'open' || state === 'blocked'),
      canDelete: s.bookedCount === 0 && state !== 'requested' && state !== 'booked',
    };
  });
};

module.exports = {
  SlotInputError,
  createDoctorSlots,
  updateDoctorSlot,
  deleteDoctorSlot,
  getDoctorSlotsWithState,
  holdIfEngaged,
  holdOverlapping,
  releaseHolds,
  BOOKING_LEAD_MINUTES,
  bookableFrom,
  getGroupedSlots,
  getAvailabilitySummary,
  getNextAvailable,
  findAvailableSlots,
  createSlots,
  updateSlot,
  deleteSlot,
  validateSlotForBooking,
  claimSlot,
  releaseSlot,
  // Deprecated aliases — see their definitions.
  incrementBookedCount,
  decrementBookedCount,
};
