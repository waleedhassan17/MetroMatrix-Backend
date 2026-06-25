const asyncHandler = require('express-async-handler');
const Doctor = require('../modules/healthcare/models/Doctor');
const Provider = require('../models/Provider');
const Notification = require('../models/Notification');

// Best-effort notification (never breaks the request).
const notifyAdmin = async (type, title, message, data = {}) => {
  try {
    await Notification.create({ type, title, message, data });
  } catch (err) {
    console.error('notifyAdmin failed:', err.message);
  }
};

// @desc    Get all pending/under_review doctors
// @route   GET /api/v1/admin/doctors/pending
// @access  Private (Admin)
const getPendingDoctors = asyncHandler(async (req, res) => {
  const doctors = await Doctor.find({
    verificationStatus: { $in: ['pending', 'under_review'] },
  })
    .populate('providerId', 'fullName email phone profilePhoto')
    .populate('specialtyId', 'name');

  res.json({
    success: true,
    data: {
      doctors,
      pendingCount: doctors.length,
    },
  });
});

// @desc    Approve a doctor
// @route   PATCH /api/v1/admin/doctors/:doctorId/approve
// @access  Private (Admin)
const approveDoctor = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findById(req.params.doctorId);
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor not found');
  }

  if (doctor.verificationStatus === 'verified') {
    res.status(400);
    throw new Error('Doctor is already approved');
  }

  const { notes } = req.body;

  // Update Doctor
  doctor.verificationStatus = 'verified';
  doctor.verificationNotes = notes || '';
  doctor.isActive = true;
  await doctor.save();

  // Update Provider
  const provider = await Provider.findById(doctor.providerId);
  if (provider) {
    provider.isActive = true;
    provider.adminVerified = 'active';
    provider.verificationStatus = 'approved';
    await provider.save();
  }

  // Notify doctor (best-effort)
  await notifyAdmin(
    'doctor_approved',
    'Account Approved',
    'Congratulations! Your doctor account has been approved. You can now start receiving appointments.',
    { providerId: doctor.providerId }
  );

  const updatedDoctor = await Doctor.findById(doctor._id)
    .populate('providerId', 'fullName email phone')
    .populate('specialtyId', 'name');

  res.json({
    success: true,
    message: 'Doctor approved successfully',
    data: { doctor: updatedDoctor },
  });
});

// @desc    Reject a doctor
// @route   PATCH /api/v1/admin/doctors/:doctorId/reject
// @access  Private (Admin)
const rejectDoctor = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findById(req.params.doctorId);
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor not found');
  }

  const { reason, canReapply } = req.body;
  if (!reason) {
    res.status(400);
    throw new Error('Rejection reason is required');
  }

  // Update Doctor
  doctor.verificationStatus = 'rejected';
  doctor.verificationNotes = reason;
  if (canReapply === false) {
    doctor.isActive = false;
  }
  await doctor.save();

  // Update Provider if not allowed to reapply
  if (canReapply === false) {
    const provider = await Provider.findById(doctor.providerId);
    if (provider) {
      provider.isActive = false;
      await provider.save();
    }
  }

  // Notify doctor (best-effort)
  await notifyAdmin(
    'doctor_rejected',
    'Verification Rejected',
    `Your account verification was rejected. Reason: ${reason}${canReapply === false ? ' You cannot reapply.' : ''}`,
    { providerId: doctor.providerId }
  );

  const updatedDoctor = await Doctor.findById(doctor._id)
    .populate('providerId', 'fullName email')
    .populate('specialtyId', 'name');

  res.json({
    success: true,
    message: 'Doctor rejected',
    data: { doctor: updatedDoctor },
  });
});

// @desc    Get all doctors with filters
// @route   GET /api/v1/admin/doctors
// @access  Private (Admin)
const getAllDoctors = asyncHandler(async (req, res) => {
  const { status, specialtyId, search, page = 1, limit = 10 } = req.query;
  const query = {};

  if (status) {
    query.verificationStatus = status;
  }
  if (specialtyId) {
    query.specialtyId = specialtyId;
  }
  if (search) {
    // Search by name in provider or pmc number
    const providers = await Provider.find({
      fullName: { $regex: search, $options: 'i' },
    }).select('_id');
    const providerIds = providers.map(p => p._id);
    query.$or = [
      { providerId: { $in: providerIds } },
      { pmcNumber: { $regex: search, $options: 'i' } },
    ];
  }

  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const skip = (pageNum - 1) * limitNum;

  const [doctors, total] = await Promise.all([
    Doctor.find(query)
      .populate('providerId', 'fullName email city')
      .populate('specialtyId', 'name')
      .skip(skip)
      .limit(limitNum)
      .sort({ createdAt: -1 }),
    Doctor.countDocuments(query),
  ]);

  // Also get total counts per status
  const statusCounts = await Doctor.aggregate([
    {
      $group: {
        _id: '$verificationStatus',
        count: { $sum: 1 },
      },
    },
  ]);
  const counts = {};
  statusCounts.forEach(s => { counts[s._id] = s.count; });

  res.json({
    success: true,
    data: {
      doctors,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
      statusCounts: counts,
    },
  });
});

module.exports = {
  getPendingDoctors,
  approveDoctor,
  rejectDoctor,
  getAllDoctors,
};