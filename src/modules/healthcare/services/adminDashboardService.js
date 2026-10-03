const Doctor = require('../models/Doctor');
const Appointment = require('../models/Appointment');
const { todayWindow } = require('../../../utils/time');

/**
 * Healthcare headline figures — used by GET /api/v1/admin/healthcare/dashboard
 * and composed into GET /api/admin/overview.
 *
 * Pending doctors are `pending` OR `under_review` — the doctor queue lists
 * both and a doctor's own submission sets `under_review`, so counting only
 * `pending` (as this did) under-reported the queue. "Today" is the
 * Asia/Karachi day. A cancellation rate with no appointments is null, not 0.
 */
const PENDING_DOCTOR_STATUSES = ['pending', 'under_review'];

async function healthcareDashboard(now = new Date()) {
  const today = todayWindow(now);
  const [pendingDoctors, appointmentsToday, revenueAgg, statusAgg, refundCandidates, topSpecialties] = await Promise.all([
    Doctor.countDocuments({ verificationStatus: { $in: PENDING_DOCTOR_STATUSES } }),
    Appointment.countDocuments({ createdAt: { $gte: today.from, $lt: today.to } }),
    Appointment.aggregate([
      { $match: { status: 'completed', completedAt: { $gte: today.from, $lt: today.to } } },
      { $group: { _id: null, revenue: { $sum: '$totalAmount' } } },
    ]),
    Appointment.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    Appointment.countDocuments({ 'payment.status': 'paid', status: 'cancelled' }),
    Appointment.aggregate([
      { $lookup: { from: 'doctors', localField: 'doctorId', foreignField: '_id', as: 'doc' } },
      { $unwind: '$doc' },
      { $group: { _id: '$doc.specialtyId', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 5 },
      { $lookup: { from: 'specialties', localField: '_id', foreignField: '_id', as: 'spec' } },
      { $unwind: { path: '$spec', preserveNullAndEmptyArrays: true } },
      { $project: { _id: 0, specialtyId: '$_id', name: '$spec.name', count: '$n' } },
    ]),
  ]);
  const byStatus = Object.fromEntries(statusAgg.map((s) => [s._id, s.n]));
  const total = statusAgg.reduce((sum, s) => sum + s.n, 0);
  return {
    pendingDoctorApprovals: pendingDoctors,
    appointmentsToday,
    revenueToday: revenueAgg[0]?.revenue || 0,
    cancellationRate: total ? Math.round(((byStatus.cancelled || 0) / total) * 1000) / 10 : null,
    openRefundCandidates: refundCandidates,
    topSpecialties,
  };
}

module.exports = { healthcareDashboard, PENDING_DOCTOR_STATUSES };
