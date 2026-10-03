const asyncHandler = require('express-async-handler');
const Doctor = require('../modules/healthcare/models/Doctor');
const Appointment = require('../modules/healthcare/models/Appointment');
const Specialty = require('../modules/healthcare/models/Specialty');
const mongoose = require('mongoose');
const { ok } = require('../utils/apiResponse');
const { monthWindows, growthPct, DEFAULT_TIMEZONE } = require('../utils/time');
const { PENDING_DOCTOR_STATUSES } = require('../modules/healthcare/services/adminDashboardService');

// @desc    Get overall platform stats
// @route   GET /api/v1/admin/analytics/stats
// @access  Private (Admin)
const getStats = asyncHandler(async (req, res) => {
  // Asia/Karachi month windows (this used to be server time). Growth compares
  // this month so far with the same stretch of last month, and is null when
  // there is nothing to compare with — it used to report +100 %.
  const w = monthWindows(new Date());
  const completedRevenue = (window) =>
    Appointment.aggregate([
      { $match: { status: 'completed' } },
      { $lookup: { from: 'slots', localField: 'slotId', foreignField: '_id', as: 'slot' } },
      { $unwind: '$slot' },
      { $match: { 'slot.date': { $gte: window.from, $lt: window.to } } },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } },
    ]).then((r) => r[0]?.total || 0);

  const [totalDoctors, verifiedDoctors, pendingVerification, totalAppointments, thisMonthRevenue, samePeriodLastMonth, lastMonthRevenue] =
    await Promise.all([
      Doctor.countDocuments(),
      Doctor.countDocuments({ verificationStatus: 'verified' }),
      Doctor.countDocuments({ verificationStatus: { $in: PENDING_DOCTOR_STATUSES } }),
      Appointment.countDocuments(),
      completedRevenue(w.thisMonth),
      completedRevenue(w.samePeriodLastMonth),
      completedRevenue(w.lastMonth),
    ]);

  ok(res, {
    totalDoctors,
    verifiedDoctors,
    pendingVerification,
    totalAppointments,
    thisMonthRevenue,
    lastMonthRevenue,
    growth: growthPct(thisMonthRevenue, samePeriodLastMonth),
    growthComparedTo: 'same_period_last_month',
    timezone: DEFAULT_TIMEZONE,
  });
});

// @desc    Appointment analytics over time
// @route   GET /api/v1/admin/analytics/appointments
// @access  Private (Admin)
const getAppointmentAnalytics = asyncHandler(async (req, res) => {
  const { period = 'daily', startDate, endDate } = req.query;

  const start = startDate ? new Date(startDate) : new Date('1970-01-01');
  const end = endDate ? new Date(endDate) : new Date('2100-01-01');
  end.setHours(23, 59, 59, 999);

  let dateFormat;
  if (period === 'weekly') {
    dateFormat = '%Y-W%V'; // ISO week
  } else if (period === 'monthly') {
    dateFormat = '%Y-%m';
  } else {
    dateFormat = '%Y-%m-%d'; // daily
  }

  const pipeline = [
    { $match: { status: { $in: ['pending', 'confirmed', 'completed', 'cancelled'] } } },
    { $lookup: { from: 'slots', localField: 'slotId', foreignField: '_id', as: 'slot' } },
    { $unwind: '$slot' },
    { $match: { 'slot.date': { $gte: start, $lte: end } } },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: dateFormat, date: '$slot.date' } },
          type: '$type', // 'in-clinic' or 'video'
        },
        total: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
      },
    },
    { $sort: { '_id.date': 1, '_id.type': 1 } },
  ];

  const results = await Appointment.aggregate(pipeline);

  // Group by date and calculate overall completion rate
  const byDate = {};
  results.forEach(item => {
    const date = item._id.date;
    if (!byDate[date]) {
      byDate[date] = {
        date,
        totalAppointments: 0,
        completedAppointments: 0,
        types: [],
      };
    }
    byDate[date].totalAppointments += item.total;
    byDate[date].completedAppointments += item.completed;
    byDate[date].types.push({
      type: item._id.type,
      total: item.total,
      completed: item.completed,
    });
  });

  const timeline = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));

  const totalAll = timeline.reduce((sum, d) => sum + d.totalAppointments, 0);
  const completedAll = timeline.reduce((sum, d) => sum + d.completedAppointments, 0);
  const completionRate = totalAll > 0 ? Math.round((completedAll / totalAll) * 10000) / 100 : null;

  ok(res, { period, timeline, overallCompletionRate: completionRate });
});

// @desc    Revenue breakdown by specialty or doctor
// @route   GET /api/v1/admin/analytics/revenue
// @access  Private (Admin)
const getRevenueAnalytics = asyncHandler(async (req, res) => {
  const { period = 'daily', startDate, endDate, groupBy = 'specialty' } = req.query;

  const start = startDate ? new Date(startDate) : new Date('1970-01-01');
  const end = endDate ? new Date(endDate) : new Date('2100-01-01');
  end.setHours(23, 59, 59, 999);

  // Build separate pipelines for doctor vs specialty grouping.
  const commonBeforeLookup = [
    { $match: { status: 'completed' } },
    { $lookup: { from: 'slots', localField: 'slotId', foreignField: '_id', as: 'slot' } },
    { $unwind: '$slot' },
    { $match: { 'slot.date': { $gte: start, $lte: end } } },
  ];

  if (groupBy === 'doctor') {
    const result = await Appointment.aggregate([
      ...commonBeforeLookup,
      {
        $group: {
          _id: '$doctorId',
          totalRevenue: { $sum: '$totalAmount' },
          appointmentCount: { $sum: 1 },
        },
      },
      { $sort: { totalRevenue: -1 } },
      {
        $lookup: {
          from: 'doctors',
          localField: '_id',
          foreignField: '_id',
          as: 'doctor',
        },
      },
      { $unwind: '$doctor' },
      {
        $lookup: {
          from: 'providers',
          localField: 'doctor.providerId',
          foreignField: '_id',
          as: 'provider',
        },
      },
      { $unwind: '$provider' },
      {
        $project: {
          _id: 0,
          doctorId: '$_id',
          doctorName: '$provider.fullName',
          totalRevenue: 1,
          appointmentCount: 1,
        },
      },
    ]);
    return ok(res, { groupBy: 'doctor', revenue: result });
  } else {
    // group by specialty
    const result = await Appointment.aggregate([
      ...commonBeforeLookup,
      {
        $lookup: {
          from: 'doctors',
          localField: 'doctorId',
          foreignField: '_id',
          as: 'doctor',
        },
      },
      { $unwind: '$doctor' },
      {
        $group: {
          _id: '$doctor.specialtyId',
          totalRevenue: { $sum: '$totalAmount' },
          appointmentCount: { $sum: 1 },
        },
      },
      { $sort: { totalRevenue: -1 } },
      {
        $lookup: {
          from: 'specialties',
          localField: '_id',
          foreignField: '_id',
          as: 'specialty',
        },
      },
      { $unwind: { path: '$specialty', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          specialtyId: '$_id',
          specialtyName: '$specialty.name',
          totalRevenue: 1,
          appointmentCount: 1,
        },
      },
    ]);
    return ok(res, { groupBy: 'specialty', revenue: result });
  }
});

module.exports = {
  getStats,
  getAppointmentAnalytics,
  getRevenueAnalytics,
};