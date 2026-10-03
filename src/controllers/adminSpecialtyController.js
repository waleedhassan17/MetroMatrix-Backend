const asyncHandler = require('express-async-handler');
const Specialty = require('../modules/healthcare/models/Specialty');
const Doctor = require('../modules/healthcare/models/Doctor');
const Appointment = require('../modules/healthcare/models/Appointment');
const auditService = require('../services/auditService');
const AppError = require('../utils/AppError');
const { ERROR_CODES } = require('../utils/errorCodes');
const { ok, created } = require('../utils/apiResponse');

const { diff } = auditService;
const audit = (req, action, specialty, { before, after, reason } = {}) =>
  auditService.audit(req, {
    module: 'healthcare',
    action: `healthcare.${action}`,
    targetType: 'Specialty',
    targetId: specialty._id,
    before,
    after,
    reason,
  });

// @desc    Get all specialties with doctor/appointment counts
// @route   GET /api/v1/admin/specialties
// @access  Private (Admin)
const getSpecialties = asyncHandler(async (req, res) => {
  const specialties = await Specialty.find({}); // Include all (active/inactive)

  // For each specialty, calculate counts in parallel
  const specialtiesWithCounts = await Promise.all(
    specialties.map(async (specialty) => {
      const approvedDoctors = await Doctor.find({
        specialtyId: specialty._id,
        verificationStatus: 'verified',
        isActive: true,
      }).select('_id');
      const doctorCount = approvedDoctors.length;
      const doctorIds = approvedDoctors.map(d => d._id);

      let appointmentCount = 0;
      if (doctorIds.length > 0) {
        appointmentCount = await Appointment.countDocuments({
          doctorId: { $in: doctorIds },
        });
      }

      return {
        ...specialty.toObject(),
        doctorCount,
        appointmentCount,
      };
    })
  );

  ok(res, specialtiesWithCounts);
});

// @desc    Create a new specialty
// @route   POST /api/v1/admin/specialties
// @access  Private (Admin)
const createSpecialty = asyncHandler(async (req, res) => {
  const { name, icon, description, commonConditions } = req.body;

  if (!name) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Specialty name is required');
  }

  // Check uniqueness
  const existing = await Specialty.findOne({ name: name.trim() });
  if (existing) {
    throw new AppError(ERROR_CODES.CONFLICT, 'A specialty with this name already exists');
  }

  const specialty = await Specialty.create({
    name: name.trim(),
    icon,
    description,
    commonConditions: commonConditions || [],
  });
  await audit(req, 'specialty.create', specialty, { after: { name: specialty.name, icon: specialty.icon } });

  created(res, specialty);
});

// @desc    Update a specialty
// @route   PATCH /api/v1/admin/specialties/:id
// @access  Private (Admin)
const updateSpecialty = asyncHandler(async (req, res) => {
  const specialty = await Specialty.findById(req.params.id);
  if (!specialty) {
    throw new AppError(ERROR_CODES.NOT_FOUND, 'Specialty not found');
  }

  const { name, icon, description, commonConditions } = req.body;
  const snapshot = (s) => ({ name: s.name, icon: s.icon, description: s.description, commonConditions: s.commonConditions });
  const before = snapshot(specialty);

  if (name && name !== specialty.name) {
    const duplicate = await Specialty.findOne({ name: name.trim(), _id: { $ne: specialty._id } });
    if (duplicate) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Another specialty already uses this name');
    }
    specialty.name = name.trim();
  }

  if (icon !== undefined) specialty.icon = icon;
  if (description !== undefined) specialty.description = description;
  if (commonConditions !== undefined) specialty.commonConditions = commonConditions;

  await specialty.save();
  const changes = diff(before, snapshot(specialty));
  await audit(req, 'specialty.update', specialty, changes);

  ok(res, specialty);
});

// @desc    Soft-delete a specialty
// @route   DELETE /api/v1/admin/specialties/:id
// @access  Private (Admin)
const deleteSpecialty = asyncHandler(async (req, res) => {
  const specialty = await Specialty.findById(req.params.id);
  if (!specialty) {
    throw new AppError(ERROR_CODES.NOT_FOUND, 'Specialty not found');
  }

  // Check for active doctors in this specialty
  const activeDoctorsCount = await Doctor.countDocuments({
    specialtyId: specialty._id,
    verificationStatus: 'verified',
    isActive: true,
  });

  if (activeDoctorsCount > 0) {
    throw new AppError(ERROR_CODES.CONFLICT, 'Cannot delete specialty with active doctors');
  }

  specialty.isActive = false;
  await specialty.save();
  await audit(req, 'specialty.deactivate', specialty, {
    before: { isActive: true },
    after: { isActive: false },
    reason: req.body?.reason,
  });

  ok(res, { id: String(specialty._id), isActive: false });
});

module.exports = {
  getSpecialties,
  createSpecialty,
  updateSpecialty,
  deleteSpecialty,
};