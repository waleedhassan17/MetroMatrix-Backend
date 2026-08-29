const mongoose = require('mongoose');
const Slot = require('../models/Slot');
const { DEFAULT_TIMEZONE } = require('../../../utils/time');

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

  return released;
};

/** @deprecated Use releaseSlot — this un-blocked doctor-blocked slots. */
const decrementBookedCount = async (slotId, session = null) => releaseSlot(slotId, session);

module.exports = {
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
