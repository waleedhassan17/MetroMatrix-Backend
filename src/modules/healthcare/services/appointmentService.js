const mongoose = require('mongoose');
const Appointment = require('../models/Appointment');
const Slot = require('../models/Slot');
const Prescription = require('../models/Prescription');
const slotService = require('./slotService');

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
  // clinicTimezone: `date` is local midnight at the clinic as a UTC instant, and
  // the app needs the zone to show it on the right calendar day.
  { path: 'slotId', select: 'date startTime endTime startUtc clinicTimezone type status maxPatients bookedCount' },
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

  // Release the slot through the shared, block-aware primitive.
  //
  // This was a local read-modify-write that set `status = 'available'`
  // UNCONDITIONALLY — so a patient cancelling on a day the doctor had
  // deliberately blocked (holiday, absence) silently re-opened that slot for
  // booking. The doctor's own cancel path guarded against exactly that, and
  // the two disagreed. releaseSlot is the single implementation, and it leaves
  // a blocked slot blocked.
  await slotService.releaseSlot(appointment.slotId._id || appointment.slotId, session);

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

  const oldSlotId = appointment.slotId._id || appointment.slotId;
  if (String(oldSlotId) === String(newSlotId)) {
    return { error: 'That is already the time of this appointment', status: 400 };
  }

  // RELEASE FIRST, THEN CLAIM — through the same two functions as booking and
  // cancelling. This used to be its own read-modify-write swap, which:
  //   · set the old slot 'available' unconditionally, re-opening a slot the
  //     doctor had deliberately BLOCKED (the bug releaseSlot exists to prevent);
  //   · checked nothing about the new slot's time, so a patient could move onto
  //     a slot that had already started;
  //   · knew nothing about overlap holds.
  // Release comes first because the new time may overlap the old one (10:00 →
  // 10:15), and the old booking would otherwise be holding the very slot being
  // claimed. Both run inside the caller's transaction, so a failed claim rolls
  // the release back and the patient keeps their original time.
  await slotService.releaseSlot(oldSlotId, session);

  const newSlot = await slotService.claimSlot(newSlotId, appointment.doctorId, session);
  if (!newSlot) {
    return {
      error: 'That time is no longer available. Please choose another.',
      status: 409,
    };
  }

  // Update appointment — including the copied time, or every doctor date
  // query would keep filing it under the old day.
  appointment.slotId = newSlot._id;
  Object.assign(appointment, require('./appointmentTime').appointmentTimeFields(newSlot));
  if (newSlot.clinicId) {
    appointment.clinicId = newSlot.clinicId;
  }
  await appointment.save({ session });

  return { appointment, newSlot };
};

// ─── Doctor: cancel (refund, release, notify) ───────
/**
 * Cancel an appointment on the doctor's side.
 *
 * The status flip is CONDITIONAL. It used to be read, check, save — so a
 * double tap (or time off cancelling an appointment the doctor was declining
 * at the same moment) passed the check twice, refunded twice and released the
 * slot twice. Now the second caller finds nothing active and stops.
 *
 * @returns {Promise<{appointment, refunded:number} | {error:string, status:number}>}
 */
const cancelByDoctor = async (appointmentId, doctorId, reason) => {
  const appointment = await Appointment.findOneAndUpdate(
    { _id: appointmentId, doctorId, status: { $in: ['pending', 'confirmed'] } },
    { $set: { status: 'cancelled', cancellationReason: reason, cancelledBy: 'doctor' } },
    { new: true }
  );

  if (!appointment) {
    const exists = await Appointment.exists({ _id: appointmentId, doctorId });
    return exists
      ? { error: 'Can only cancel pending or confirmed appointments', status: 400 }
      : { error: 'Appointment not found', status: 404 };
  }

  // Doctor-initiated cancellation always refunds the patient in full.
  let refunded = 0;
  try {
    refunded = await require('./paymentService').refundAppointment(appointment, {
      cancelledBy: 'doctor',
      reason: `Refund: appointment cancelled by doctor (${reason})`,
    });
  } catch (err) {
    console.error('Refund failed:', err.message);
  }

  // Atomic, keeps a doctor-blocked slot blocked, and releases the overlapping
  // slots this booking was holding.
  if (appointment.slotId) await slotService.releaseSlot(appointment.slotId);

  try {
    await require('./notificationService').createNotification({
      userId: appointment.patientId,
      type: 'appointment_cancelled',
      title: 'Appointment Cancelled',
      message:
        refunded > 0
          ? `Your appointment has been cancelled by the doctor and PKR ${refunded} was refunded to your wallet. Reason: ${reason}`
          : `Your appointment has been cancelled by the doctor. Reason: ${reason}`,
      data: { appointmentId: appointment._id },
    });
  } catch (err) {
    console.error('Cancellation notification failed:', err.message);
  }

  return { appointment, refunded };
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
  cancelByDoctor,
  rescheduleAppointment,
  getDoctorAppointments,
  createAppointment,
  findAppointmentById,
  computeModifyFlags,
  PATIENT_POPULATE,
  DETAIL_POPULATE,
  DOCTOR_POPULATE,
};
