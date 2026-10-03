const asyncHandler = require('express-async-handler');
const Doctor = require('../modules/healthcare/models/Doctor');
const Provider = require('../models/Provider');
const auditService = require('../services/auditService');
const providerStatus = require('../services/admin/providerStatus');
const AppError = require('../utils/AppError');
const { ERROR_CODES } = require('../utils/errorCodes');
const { ok } = require('../utils/apiResponse');
const { clampInt, searchRegex, MAX_PAGE_SIZE } = require('../utils/pagination');

// Doctor decisions are recorded in the unified AdminAuditLog. (They used to
// post a message addressed to the doctor — "Congratulations! Your doctor
// account…" — into the ADMIN notification feed, where no doctor would see it.)
const audit = (req, action, doctor, { before, after, reason } = {}) =>
  auditService.audit(req, {
    module: 'healthcare',
    action: `healthcare.${action}`,
    targetType: 'Doctor',
    targetId: doctor._id,
    before,
    after,
    reason,
  });

// @desc    Get all pending/under_review doctors
// @route   GET /api/v1/admin/doctors/pending
// @access  Private (Admin)
const getPendingDoctors = asyncHandler(async (req, res) => {
  const doctors = await Doctor.find({
    verificationStatus: { $in: ['pending', 'under_review'] },
  })
    .populate('providerId', 'fullName email phone profilePhoto')
    .populate('specialtyId', 'name')
    .sort({ createdAt: 1 })
    .limit(MAX_PAGE_SIZE);
  const total = await Doctor.countDocuments({ verificationStatus: { $in: ['pending', 'under_review'] } });

  ok(res, doctors, { page: 1, limit: MAX_PAGE_SIZE, total, pages: Math.max(1, Math.ceil(total / MAX_PAGE_SIZE)) });
});

// @desc    Approve a doctor
// @route   PATCH /api/v1/admin/doctors/:doctorId/approve
// @access  Private (Admin)
const approveDoctor = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findById(req.params.doctorId);
  if (!doctor) throw new AppError(ERROR_CODES.NOT_FOUND, 'Doctor not found');
  if (doctor.verificationStatus === 'verified') throw new AppError(ERROR_CODES.CONFLICT, 'Doctor is already approved');

  const { notes } = req.body;
  const before = { verificationStatus: doctor.verificationStatus, isActive: doctor.isActive };

  // Update Doctor
  doctor.verificationStatus = 'verified';
  doctor.verificationNotes = notes || '';
  doctor.isActive = true;
  await doctor.save();

  // The doctor's provider account follows (single writer keeps
  // verificationStatus, adminVerified and isActive in step).
  const provider = await Provider.findById(doctor.providerId);
  if (provider) {
    providerStatus.approve(provider, { admin: req.user, notes });
    await provider.save();
  }

  await audit(req, 'doctor.approve', doctor, {
    before,
    after: { verificationStatus: 'verified', isActive: true },
    reason: notes,
  });

  const updatedDoctor = await Doctor.findById(doctor._id)
    .populate('providerId', 'fullName email phone')
    .populate('specialtyId', 'name');

  ok(res, updatedDoctor);
});

// @desc    Reject a doctor
// @route   PATCH /api/v1/admin/doctors/:doctorId/reject
// @access  Private (Admin)
const rejectDoctor = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findById(req.params.doctorId);
  if (!doctor) throw new AppError(ERROR_CODES.NOT_FOUND, 'Doctor not found');

  const { reason, canReapply } = req.body;
  if (!reason || !String(reason).trim()) throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Rejection reason is required');

  const before = { verificationStatus: doctor.verificationStatus, isActive: doctor.isActive };

  // Update Doctor
  doctor.verificationStatus = 'rejected';
  doctor.verificationNotes = reason;
  if (canReapply === false) {
    doctor.isActive = false;
  }
  await doctor.save();

  // Not allowed to reapply: the provider account is rejected too (it used to
  // only flip isActive, so the account showed as neither pending nor rejected).
  if (canReapply === false) {
    const provider = await Provider.findById(doctor.providerId);
    if (provider) {
      providerStatus.reject(provider, { admin: req.user, reason });
      provider.isActive = false;
      await provider.save();
    }
  }

  await audit(req, 'doctor.reject', doctor, {
    before,
    after: { verificationStatus: 'rejected', isActive: doctor.isActive, canReapply: canReapply !== false },
    reason,
  });

  const updatedDoctor = await Doctor.findById(doctor._id)
    .populate('providerId', 'fullName email')
    .populate('specialtyId', 'name');

  ok(res, updatedDoctor);
});

// @desc    Get all doctors with filters
// @route   GET /api/v1/admin/doctors
// @access  Private (Admin)
const getAllDoctors = asyncHandler(async (req, res) => {
  const { status, specialtyId, search } = req.query;
  const query = {};

  if (status) {
    query.verificationStatus = String(status);
  }
  if (specialtyId) {
    query.specialtyId = specialtyId;
  }
  if (search) {
    // Search by the doctor's name (on their provider account) or PMC number.
    const re = searchRegex(search);
    const providerIds = await Provider.find({ fullName: re }).distinct('_id');
    query.$or = [{ providerId: { $in: providerIds } }, { pmcNumber: re }];
  }

  const page = clampInt(req.query.page, 1, 1, 1000000);
  const limit = clampInt(req.query.limit, 10, 1, MAX_PAGE_SIZE);

  const [doctors, total, statusCounts] = await Promise.all([
    Doctor.find(query)
      .populate('providerId', 'fullName email city')
      .populate('specialtyId', 'name')
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Doctor.countDocuments(query),
    Doctor.aggregate([{ $group: { _id: '$verificationStatus', count: { $sum: 1 } } }]),
  ]);

  const counts = Object.fromEntries(statusCounts.map((s) => [s._id, s.count]));
  ok(res, doctors, { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)), counts });
});

module.exports = {
  getPendingDoctors,
  approveDoctor,
  rejectDoctor,
  getAllDoctors,
};