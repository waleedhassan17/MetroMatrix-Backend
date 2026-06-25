const mongoose = require('mongoose');
const Appointment = require('../models/Appointment');
const Slot = require('../models/Slot');
const Prescription = require('../models/Prescription');

// ─── Population configs ─────────────────────────────
const PATIENT_POPULATE = [
  {
    path: 'doctorId',
    populate: [
      { path: 'providerId', select: 'fullName profilePhoto' },
      { path: 'specialtyId', select: 'name icon' },
    ],
  },
  { path: 'slotId', select: 'date startTime endTime type' },
  { path: 'clinicId', select: 'name address phone city' },
];

const DETAIL_POPULATE = [
  {
    path: 'doctorId',
    populate: [
      { path: 'providerId', select: 'fullName profilePhoto email' },
      { path: 'specialtyId', select: 'name icon description' },
    ],
  },
  { path: 'patientId', select: 'fullName email phoneNumber avatar' },
  { path: 'slotId', select: 'date startTime endTime type status maxPatients bookedCount' },
  { path: 'clinicId', select: 'name address phone city area location' },
];

const DOCTOR_POPULATE = [
  { path: 'patientId', select: 'fullName email phoneNumber avatar' },
  { path: 'slotId', select: 'date startTime endTime type' },
  { path: 'clinicId', select: 'name address' },
];

// ─── canCancel / canReschedule computation ──────────
const computeModifyFlags = (appointment) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Get the appointment date from the populated slot or fall back
  let apptDate;
  if (appointment.slotId && appointment.slotId.date) {
    apptDate = new Date(appointment.slotId.date);
  } else {
    // Fallback: use createdAt (shouldn't happen with proper population)
    apptDate = new Date(appointment.createdAt);
  }
  apptDate.setHours(0, 0, 0, 0);

  const canModify =
    ['pending', 'confirmed'].includes(appointment.status) &&
    apptDate > today;

  return { canCancel: canModify, canReschedule: canModify };
};

// ─── Patient: get appointments with status filter ───
const getPatientAppointments = async (patientId, filters = {}, options = {}) => {
  const { status } = filters;
  const { page = 1, limit = 10 } = options;
  const skip = (page - 1) * Number(limit);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let query = { patientId };

  // We need to handle the status filter after population because
  // "upcoming" and "past" depend on slot.date. We'll use aggregation.
  // But for simpler queries (cancelled), we can use find().
  if (status === 'cancelled') {
    query.status = 'cancelled';
  }

  // For upcoming and past, we need the slot date. Use a two-step approach:
  // 1. Fetch appointments with populated slots
  // 2. Filter by date in application layer (more flexible than $lookup agg)
  if (status === 'upcoming' || status === 'past') {
    // Fetch all non-cancelled appointments for the user, then filter
    if (status === 'upcoming') {
      query.status = { $in: ['pending', 'confirmed'] };
    }
    if (status === 'past') {
      // Past: completed OR any status where slot date < today
      // First get completed ones plus ones with past dates
      query.$or = [
        { status: 'completed' },
        { status: { $in: ['pending', 'confirmed'] } },
      ];
    }
  }

  // Get total for given query BEFORE slot-date filtering
  // For accurate pagination with date filter, we do a lookup-based count
  let appointments = await Appointment.find(query)
    .populate(PATIENT_POPULATE)
    .sort({ createdAt: -1 })
    .lean();

  // Apply slot-date filtering for upcoming/past
  if (status === 'upcoming') {
    appointments = appointments.filter((appt) => {
      if (!appt.slotId || !appt.slotId.date) return false;
      const slotDate = new Date(appt.slotId.date);
      slotDate.setHours(0, 0, 0, 0);
      return slotDate >= today;
    });
  } else if (status === 'past') {
    appointments = appointments.filter((appt) => {
      if (appt.status === 'completed') return true;
      if (!appt.slotId || !appt.slotId.date) return false;
      const slotDate = new Date(appt.slotId.date);
      slotDate.setHours(0, 0, 0, 0);
      return slotDate < today;
    });
  }

  const total = appointments.length;

  // Apply pagination manually after filtering
  const paginated = appointments.slice(skip, skip + Number(limit));

  // Add modify flags
  const enriched = paginated.map((appt) => ({
    ...appt,
    id: appt._id,
    ...computeModifyFlags(appt),
  }));

  return {
    appointments: enriched,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      pages: Math.ceil(total / Number(limit)),
    },
  };
};

// ─── Patient: get single appointment detail ─────────
const getAppointmentDetail = async (appointmentId, patientId) => {
  const appointment = await Appointment.findById(appointmentId)
    .populate(DETAIL_POPULATE)
    .lean();

  if (!appointment) return null;
  if (appointment.patientId._id.toString() !== patientId.toString()) {
    return { forbidden: true };
  }

  // Look up prescription if it exists
  const prescription = await Prescription.findOne({ appointmentId })
    .populate({
      path: 'doctorId',
      populate: [
        { path: 'providerId', select: 'fullName profilePhoto' },
        { path: 'specialtyId', select: 'name' },
      ],
    })
    .lean();

  return {
    ...appointment,
    id: appointment._id,
    prescription: prescription
      ? { ...prescription, id: prescription._id }
      : null,
    ...computeModifyFlags(appointment),
  };
};

// ─── Patient: cancel appointment (transactional) ────
const cancelAppointment = async (appointmentId, patientId, reason, session) => {
  const appointment = await Appointment.findById(appointmentId)
    .populate('slotId', 'date startTime endTime maxPatients bookedCount status')
    .session(session);

  if (!appointment) {
    return { error: 'Appointment not found', status: 404 };
  }
  if (appointment.patientId.toString() !== patientId.toString()) {
    return { error: 'Access denied', status: 403 };
  }

  const { canCancel } = computeModifyFlags(appointment);
  if (!canCancel) {
    return {
      error: 'This appointment cannot be cancelled. It may be in the past, already completed, or already cancelled.',
      status: 400,
    };
  }

  // Update appointment
  appointment.status = 'cancelled';
  appointment.cancellationReason = reason;
  await appointment.save({ session });

  // Release the slot
  const slot = await Slot.findById(appointment.slotId._id || appointment.slotId).session(session);
  if (slot) {
    slot.bookedCount = Math.max(0, slot.bookedCount - 1);
    if (slot.bookedCount < slot.maxPatients) {
      slot.status = 'available';
    }
    await slot.save({ session });
  }

  return { appointment };
};

// ─── Patient: reschedule appointment (transactional) ─
const rescheduleAppointment = async (appointmentId, patientId, newSlotId, session) => {
  const appointment = await Appointment.findById(appointmentId)
    .populate('slotId', 'date startTime endTime maxPatients bookedCount status')
    .session(session);

  if (!appointment) {
    return { error: 'Appointment not found', status: 404 };
  }
  if (appointment.patientId.toString() !== patientId.toString()) {
    return { error: 'Access denied', status: 403 };
  }

  const { canReschedule } = computeModifyFlags(appointment);
  if (!canReschedule) {
    return {
      error: 'This appointment cannot be rescheduled. It may be in the past, already completed, or already cancelled.',
      status: 400,
    };
  }

  // Validate new slot
  const newSlot = await Slot.findOne({
    _id: newSlotId,
    doctorId: appointment.doctorId,
    status: 'available',
  }).session(session);

  if (!newSlot) {
    return { error: 'New slot is not available or does not belong to the same doctor', status: 400 };
  }
  if (newSlot.bookedCount >= newSlot.maxPatients) {
    return { error: 'New slot is fully booked', status: 400 };
  }

  // Release old slot
  const oldSlot = await Slot.findById(appointment.slotId._id || appointment.slotId).session(session);
  if (oldSlot) {
    oldSlot.bookedCount = Math.max(0, oldSlot.bookedCount - 1);
    if (oldSlot.bookedCount < oldSlot.maxPatients) {
      oldSlot.status = 'available';
    }
    await oldSlot.save({ session });
  }

  // Book new slot
  newSlot.bookedCount += 1;
  if (newSlot.bookedCount >= newSlot.maxPatients) {
    newSlot.status = 'booked';
  }
  await newSlot.save({ session });

  // Update appointment
  appointment.slotId = newSlot._id;
  if (newSlot.clinicId) {
    appointment.clinicId = newSlot.clinicId;
  }
  await appointment.save({ session });

  return { appointment, newSlot };
};

// ─── Doctor: get appointments ───────────────────────
const getDoctorAppointments = async (doctorId, filters = {}, options = {}) => {
  const { status, date } = filters;
  const { page = 1, limit = 10 } = options;
  const skip = (page - 1) * Number(limit);

  const query = { doctorId };
  if (status) query.status = status;
  if (date) {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);
    query.createdAt = { $gte: startOfDay, $lte: endOfDay };
  }

  const [appointments, total] = await Promise.all([
    Appointment.find(query)
      .populate(DOCTOR_POPULATE)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean(),
    Appointment.countDocuments(query),
  ]);

  return {
    appointments: appointments.map((a) => ({ ...a, id: a._id })),
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      pages: Math.ceil(total / Number(limit)),
    },
  };
};

// ─── Shared: create appointment ─────────────────────
const createAppointment = async (data, session = null) => {
  const opts = session ? [data, { session }] : [data];
  const result = await Appointment.create(...(session ? [[data], { session }] : [data]));
  return session ? result[0] : result;
};

// ─── Shared: find by ID ─────────────────────────────
const findAppointmentById = async (id) => {
  return Appointment.findById(id).populate(DETAIL_POPULATE);
};

module.exports = {
  getPatientAppointments,
  getAppointmentDetail,
  cancelAppointment,
  rescheduleAppointment,
  getDoctorAppointments,
  createAppointment,
  findAppointmentById,
  computeModifyFlags,
  PATIENT_POPULATE,
  DETAIL_POPULATE,
  DOCTOR_POPULATE,
};
