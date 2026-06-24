const mongoose = require('mongoose');
const Slot = require('../models/Slot');

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
  };

  if (type) query.type = type;
  if (clinicId) query.clinicId = new mongoose.Types.ObjectId(clinicId);

  const slots = await Slot.find(query)
    .populate('clinicId', 'name address')
    .sort({ startTime: 1 })
    .lean();

  // Group into morning, afternoon, evening
  const grouped = {
    morning: { ...TIME_BUCKETS.morning, slots: [] },
    afternoon: { ...TIME_BUCKETS.afternoon, slots: [] },
    evening: { ...TIME_BUCKETS.evening, slots: [] },
  };

  slots.forEach((slot) => {
    const bucket = getTimeBucket(slot.startTime);
    if (grouped[bucket]) {
      grouped[bucket].slots.push({
        slotId: slot._id,
        startTime: slot.startTime,
        endTime: slot.endTime,
        type: slot.type,
        isAvailable: slot.bookedCount < slot.maxPatients,
        clinic: slot.clinicId || null,
      });
    }
  });

  return grouped;
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
 * Validate that a slot is bookable. Returns the slot doc or null.
 */
const validateSlotForBooking = async (slotId, doctorId, session = null) => {
  const opts = session ? { session } : {};
  const slot = await Slot.findOne({
    _id: slotId,
    doctorId,
    status: 'available',
  }).session(session);

  if (!slot) return null;
  if (slot.bookedCount >= slot.maxPatients) return null;
  return slot;
};

/**
 * Increment the booked count on a slot. Flip status if full.
 * Must be called inside a session/transaction.
 */
const incrementBookedCount = async (slotId, session = null) => {
  const opts = session ? { session } : {};
  const slot = await Slot.findById(slotId).session(session);
  if (!slot) return null;

  slot.bookedCount += 1;
  if (slot.bookedCount >= slot.maxPatients) {
    slot.status = 'booked';
  }
  await slot.save(opts);
  return slot;
};

/**
 * Decrement the booked count on a slot (e.g. cancellation). Flip status back.
 */
const decrementBookedCount = async (slotId, session = null) => {
  const opts = session ? { session } : {};
  const slot = await Slot.findById(slotId).session(session);
  if (!slot) return null;

  slot.bookedCount = Math.max(0, slot.bookedCount - 1);
  if (slot.bookedCount < slot.maxPatients) {
    slot.status = 'available';
  }
  await slot.save(opts);
  return slot;
};

module.exports = {
  getGroupedSlots,
  findAvailableSlots,
  createSlots,
  updateSlot,
  deleteSlot,
  validateSlotForBooking,
  incrementBookedCount,
  decrementBookedCount,
};
