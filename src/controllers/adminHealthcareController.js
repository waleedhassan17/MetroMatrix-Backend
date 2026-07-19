const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Doctor = require('../modules/healthcare/models/Doctor');
const Appointment = require('../modules/healthcare/models/Appointment');
const Clinic = require('../modules/healthcare/models/Clinic');
const Review = require('../modules/healthcare/models/Review');
const Specialty = require('../modules/healthcare/models/Specialty');
const HealthcareAuditLog = require('../modules/healthcare/models/HealthcareAuditLog');
const Provider = require('../models/Provider');
const User = require('../models/User');
const paymentService = require('../modules/healthcare/services/paymentService');
const {
  getHealthcareSettings,
  updateHealthcareSettings,
} = require('../modules/healthcare/services/settingsService');

/** Append to the healthcare audit trail. Never throws into the request path. */
const audit = async (adminId, action, targetType, targetId, extra = {}) => {
  try {
    await HealthcareAuditLog.create({ admin: adminId, action, targetType, targetId, ...extra });
  } catch (e) {
    console.error('[healthcare] audit write failed:', e.message);
  }
};

const parsePage = (q) => {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
};

/**
 * ── 1. Doctor oversight ────────────────────────────────────────────
 */

// @desc  GET /api/v1/admin/doctors/:doctorId — full detail
const getDoctorDetail = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findById(req.params.doctorId)
    .populate('providerId', 'fullName email phoneNumber documents adminVerified profilePhoto')
    .populate('specialtyId', 'name');
  if (!doctor) {
    return res.status(404).json({ success: false, error: 'Doctor not found' });
  }
  const [clinics, appointmentCount, revenueAgg, reviewCount] = await Promise.all([
    Clinic.find({ doctorId: doctor._id }),
    Appointment.countDocuments({ doctorId: doctor._id }),
    Appointment.aggregate([
      { $match: { doctorId: doctor._id, status: 'completed' } },
      { $group: { _id: null, revenue: { $sum: '$totalAmount' } } },
    ]),
    Review.countDocuments({ doctorId: doctor._id }),
  ]);
  return res.json({
    success: true,
    data: {
      doctor,
      clinics,
      stats: {
        appointmentCount,
        revenue: revenueAgg.length ? revenueAgg[0].revenue : 0,
        rating: doctor.rating,
        reviewCount,
      },
    },
  });
});

// @desc  PATCH /api/v1/admin/doctors/:doctorId/status { status: active|suspended, reason }
// Suspending hides the doctor from patient search (search filters isActive)
// and blocks new bookings; existing appointments stay intact.
const setDoctorStatus = asyncHandler(async (req, res) => {
  const { status, reason } = req.body;
  if (!['active', 'suspended'].includes(status)) {
    return res.status(400).json({ success: false, error: "status must be 'active' or 'suspended'" });
  }
  if (!reason) {
    return res.status(400).json({ success: false, error: 'A reason is mandatory' });
  }
  const doctor = await Doctor.findById(req.params.doctorId);
  if (!doctor) return res.status(404).json({ success: false, error: 'Doctor not found' });
  const before = { isActive: doctor.isActive };
  doctor.isActive = status === 'active';
  await doctor.save();
  await audit(req.user._id, 'set_doctor_status', 'Doctor', doctor._id, {
    before,
    after: { isActive: doctor.isActive },
    reason,
  });
  return res.json({ success: true, data: doctor });
});

// @desc  PATCH /api/v1/admin/doctors/:doctorId — admin profile edit
const updateDoctorProfile = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findById(req.params.doctorId);
  if (!doctor) return res.status(404).json({ success: false, error: 'Doctor not found' });
  const before = doctor.toObject();
  const editable = ['consultationFee', 'videoConsultationFee', 'experience', 'qualifications', 'bio', 'about', 'specialtyId'];
  editable.forEach((f) => {
    if (req.body[f] !== undefined) doctor[f] = req.body[f];
  });
  await doctor.save();
  await audit(req.user._id, 'update_doctor', 'Doctor', doctor._id, { before, after: doctor.toObject() });
  return res.json({ success: true, data: doctor });
});

// @desc  GET /api/v1/admin/doctors/:doctorId/documents — re-review verification docs
const getDoctorDocuments = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findById(req.params.doctorId).populate(
    'providerId',
    'fullName email documents adminVerified emailVerified'
  );
  if (!doctor) return res.status(404).json({ success: false, error: 'Doctor not found' });
  return res.json({
    success: true,
    data: {
      doctorId: doctor._id,
      verificationStatus: doctor.verificationStatus,
      provider: doctor.providerId,
    },
  });
});

/**
 * ── 2. Appointment oversight ───────────────────────────────────────
 */

// @desc  GET /api/v1/admin/appointments — all appointments, filtered
const listAppointments = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePage(req.query);
  const filter = {};
  if (req.query.doctorId) filter.doctorId = req.query.doctorId;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.type) filter.type = req.query.type;
  if (req.query.from || req.query.to) {
    filter.createdAt = {};
    if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
    if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
  }
  if (req.query.patient) {
    const rx = new RegExp(String(req.query.patient).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const users = await User.find({ $or: [{ fullName: rx }, { email: rx }] }).select('_id');
    filter.patientId = { $in: users.map((u) => u._id) };
  }

  const [appointments, total] = await Promise.all([
    Appointment.find(filter)
      .populate('patientId', 'fullName email')
      .populate({ path: 'doctorId', select: 'providerId specialtyId', populate: [{ path: 'providerId', select: 'fullName' }, { path: 'specialtyId', select: 'name' }] })
      .populate('slotId', 'date startTime endTime')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Appointment.countDocuments(filter),
  ]);
  return res.json({
    success: true,
    data: appointments,
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  });
});

// @desc  GET /api/v1/admin/appointments/:id — full detail incl. payment trail
const getAppointmentDetail = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, error: 'Invalid appointment ID' });
  }
  const appointment = await Appointment.findById(req.params.id)
    .populate('patientId', 'fullName email phoneNumber')
    .populate({ path: 'doctorId', select: 'providerId specialtyId consultationFee', populate: [{ path: 'providerId', select: 'fullName email' }, { path: 'specialtyId', select: 'name' }] })
    .populate('clinicId', 'name address city')
    .populate('slotId', 'date startTime endTime');
  if (!appointment) return res.status(404).json({ success: false, error: 'Appointment not found' });
  return res.json({ success: true, data: appointment });
});

const ADMIN_TRANSITIONS = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

// @desc  PATCH /api/v1/admin/appointments/:id/status { status, reason } — force-transition
const forceAppointmentStatus = asyncHandler(async (req, res) => {
  const { status, reason } = req.body;
  if (!reason) return res.status(400).json({ success: false, error: 'A reason is mandatory for admin status changes' });
  const appointment = await Appointment.findById(req.params.id);
  if (!appointment) return res.status(404).json({ success: false, error: 'Appointment not found' });
  if (!(ADMIN_TRANSITIONS[appointment.status] || []).includes(status)) {
    return res.status(400).json({
      success: false,
      error: `Cannot move an appointment from '${appointment.status}' to '${status}'`,
    });
  }
  const before = appointment.status;
  appointment.status = status;
  if (status === 'cancelled') {
    appointment.cancellationReason = `[admin] ${reason}`;
    appointment.cancelledBy = 'system';
    await appointment.save();
    // Admin cancellation refunds in full
    await paymentService.refundAppointment(appointment, {
      cancelledBy: 'system',
      reason: `Refund: appointment cancelled by admin (${reason})`,
    });
  } else if (status === 'completed') {
    appointment.completedAt = new Date();
    await appointment.save();
    await paymentService.settleCompletedAppointment(appointment);
  } else {
    await appointment.save();
  }
  await audit(req.user._id, 'force_appointment_status', 'Appointment', appointment._id, {
    before: { status: before },
    after: { status },
    reason,
  });
  return res.json({ success: true, data: appointment });
});

// @desc  POST /api/v1/admin/appointments/:id/refund { reason } — manual wallet refund
const refundAppointment = asyncHandler(async (req, res) => {
  if (!req.body.reason) {
    return res.status(400).json({ success: false, error: 'A reason is mandatory for manual refunds' });
  }
  const appointment = await Appointment.findById(req.params.id).populate('slotId', 'date startTime');
  if (!appointment) return res.status(404).json({ success: false, error: 'Appointment not found' });
  if (!appointment.payment || appointment.payment.status !== 'paid') {
    return res.status(400).json({
      success: false,
      error: `Only paid appointments can be refunded (this one is '${appointment.payment?.status || 'unpaid'}')`,
    });
  }
  const refunded = await paymentService.refundAppointment(appointment, {
    cancelledBy: 'system',
    reason: `Manual refund by admin: ${req.body.reason}`,
    ratioOverride: 1,
  });
  await audit(req.user._id, 'manual_refund', 'Appointment', appointment._id, {
    after: { refunded },
    reason: req.body.reason,
  });
  return res.json({ success: true, data: { refunded, appointment } });
});

/**
 * ── 3. Clinic oversight ────────────────────────────────────────────
 */

const listClinics = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePage(req.query);
  const filter = {};
  if (req.query.doctorId) filter.doctorId = req.query.doctorId;
  if (req.query.city) filter.city = new RegExp(`^${String(req.query.city).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const [clinics, total] = await Promise.all([
    Clinic.find(filter)
      .populate({ path: 'doctorId', select: 'providerId', populate: { path: 'providerId', select: 'fullName' } })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Clinic.countDocuments(filter),
  ]);
  return res.json({
    success: true,
    data: clinics,
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  });
});

const getClinicDetail = asyncHandler(async (req, res) => {
  const clinic = await Clinic.findById(req.params.id).populate({
    path: 'doctorId',
    select: 'providerId specialtyId',
    populate: [{ path: 'providerId', select: 'fullName email' }, { path: 'specialtyId', select: 'name' }],
  });
  if (!clinic) return res.status(404).json({ success: false, error: 'Clinic not found' });
  return res.json({ success: true, data: clinic });
});

const setClinicStatus = asyncHandler(async (req, res) => {
  const clinic = await Clinic.findById(req.params.id);
  if (!clinic) return res.status(404).json({ success: false, error: 'Clinic not found' });
  const before = { isActive: clinic.isActive };
  clinic.isActive = req.body.isActive !== undefined ? !!req.body.isActive : !clinic.isActive;
  await clinic.save();
  await audit(req.user._id, 'set_clinic_status', 'Clinic', clinic._id, {
    before,
    after: { isActive: clinic.isActive },
    reason: req.body.reason,
  });
  return res.json({ success: true, data: clinic });
});

/**
 * ── 4. Review moderation ───────────────────────────────────────────
 */

const listReviews = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePage(req.query);
  const filter = {};
  if (req.query.doctorId) filter.doctorId = req.query.doctorId;
  if (req.query.rating) filter.rating = Number(req.query.rating);
  if (req.query.maxRating) filter.rating = { $lte: Number(req.query.maxRating) };
  const [reviews, total] = await Promise.all([
    Review.find(filter)
      .populate('patientId', 'fullName')
      .populate({ path: 'doctorId', select: 'providerId rating', populate: { path: 'providerId', select: 'fullName' } })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Review.countDocuments(filter),
  ]);
  return res.json({
    success: true,
    data: reviews,
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  });
});

// @desc  DELETE /api/v1/admin/healthcare/reviews/:id { reason }
// Recomputes the doctor's rating aggregate atomically from remaining reviews.
const deleteReview = asyncHandler(async (req, res) => {
  if (!req.body.reason) {
    return res.status(400).json({ success: false, error: 'A reason is mandatory when removing a review' });
  }
  const review = await Review.findById(req.params.id);
  if (!review) return res.status(404).json({ success: false, error: 'Review not found' });
  const doctorId = review.doctorId;
  const before = review.toObject();
  await review.deleteOne();

  const [agg] = await Review.aggregate([
    { $match: { doctorId } },
    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  await Doctor.updateOne(
    { _id: doctorId },
    {
      $set: {
        rating: Math.round((agg?.avg || 0) * 10) / 10,
        totalReviews: agg?.count || 0,
      },
    }
  );
  await audit(req.user._id, 'delete_review', 'Review', review._id, { before, reason: req.body.reason });
  return res.json({ success: true, message: 'Review removed and doctor rating recomputed' });
});

/**
 * ── 5. Dashboard + extended analytics ──────────────────────────────
 */

const dashboard = asyncHandler(async (req, res) => {
  const dayStart = new Date(new Date().setHours(0, 0, 0, 0));
  const [pendingDoctors, appointmentsToday, revenueAgg, cancelStats, refundOpen, topSpecialties] =
    await Promise.all([
      Doctor.countDocuments({ verificationStatus: 'pending' }),
      Appointment.countDocuments({ createdAt: { $gte: dayStart } }),
      Appointment.aggregate([
        { $match: { status: 'completed', completedAt: { $gte: dayStart } } },
        { $group: { _id: null, revenue: { $sum: '$totalAmount' } } },
      ]),
      Appointment.aggregate([
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ]),
      Appointment.countDocuments({ 'payment.status': 'paid', status: 'cancelled' }),
      Appointment.aggregate([
        { $lookup: { from: 'doctors', localField: 'doctorId', foreignField: '_id', as: 'doc' } },
        { $unwind: '$doc' },
        { $group: { _id: '$doc.specialtyId', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 5 },
        { $lookup: { from: 'specialties', localField: '_id', foreignField: '_id', as: 'spec' } },
        { $unwind: { path: '$spec', preserveNullAndEmptyArrays: true } },
        { $project: { name: '$spec.name', count: '$n' } },
      ]),
    ]);
  const statusCounts = {};
  let totalAppointments = 0;
  cancelStats.forEach((s) => {
    statusCounts[s._id] = s.n;
    totalAppointments += s.n;
  });
  return res.json({
    success: true,
    data: {
      pendingDoctorApprovals: pendingDoctors,
      appointmentsToday,
      revenueToday: revenueAgg.length ? revenueAgg[0].revenue : 0,
      cancellationRate: totalAppointments
        ? Math.round(((statusCounts.cancelled || 0) / totalAppointments) * 1000) / 10
        : 0,
      openRefundCandidates: refundOpen,
      topSpecialties,
    },
  });
});

/**
 * ── 6. Settings ────────────────────────────────────────────────────
 */

const getSettings = asyncHandler(async (req, res) =>
  res.json({ success: true, data: await getHealthcareSettings() })
);

const patchSettings = asyncHandler(async (req, res) => {
  const before = await getHealthcareSettings();
  const after = await updateHealthcareSettings(req.body, req.user._id);
  await audit(req.user._id, 'update_settings', 'HealthcareSettings', null, { before, after });
  return res.json({ success: true, data: after });
});

module.exports = {
  getDoctorDetail,
  setDoctorStatus,
  updateDoctorProfile,
  getDoctorDocuments,
  listAppointments,
  getAppointmentDetail,
  forceAppointmentStatus,
  refundAppointment,
  listClinics,
  getClinicDetail,
  setClinicStatus,
  listReviews,
  deleteReview,
  dashboard,
  getSettings,
  patchSettings,
};
