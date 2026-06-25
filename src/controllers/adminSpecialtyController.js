const asyncHandler = require('express-async-handler');
const Specialty = require('../modules/healthcare/models/Specialty');
const Doctor = require('../modules/healthcare/models/Doctor');
const Appointment = require('../modules/healthcare/models/Appointment');

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

  res.json({ success: true, data: { specialties: specialtiesWithCounts } });
});

// @desc    Create a new specialty
// @route   POST /api/v1/admin/specialties
// @access  Private (Admin)
const createSpecialty = asyncHandler(async (req, res) => {
  const { name, icon, description, commonConditions } = req.body;

  if (!name) {
    res.status(400);
    throw new Error('Specialty name is required');
  }

  // Check uniqueness
  const existing = await Specialty.findOne({ name: name.trim() });
  if (existing) {
    res.status(400);
    throw new Error('A specialty with this name already exists');
  }

  const specialty = await Specialty.create({
    name: name.trim(),
    icon,
    description,
    commonConditions: commonConditions || [],
  });

  res.status(201).json({
    success: true,
    data: { specialty },
  });
});

// @desc    Update a specialty
// @route   PATCH /api/v1/admin/specialties/:id
// @access  Private (Admin)
const updateSpecialty = asyncHandler(async (req, res) => {
  const specialty = await Specialty.findById(req.params.id);
  if (!specialty) {
    res.status(404);
    throw new Error('Specialty not found');
  }

  const { name, icon, description, commonConditions } = req.body;

  if (name && name !== specialty.name) {
    const duplicate = await Specialty.findOne({ name: name.trim(), _id: { $ne: specialty._id } });
    if (duplicate) {
      res.status(400);
      throw new Error('Another specialty already uses this name');
    }
    specialty.name = name.trim();
  }

  if (icon !== undefined) specialty.icon = icon;
  if (description !== undefined) specialty.description = description;
  if (commonConditions !== undefined) specialty.commonConditions = commonConditions;

  await specialty.save();

  res.json({
    success: true,
    data: { specialty },
  });
});

// @desc    Soft-delete a specialty
// @route   DELETE /api/v1/admin/specialties/:id
// @access  Private (Admin)
const deleteSpecialty = asyncHandler(async (req, res) => {
  const specialty = await Specialty.findById(req.params.id);
  if (!specialty) {
    res.status(404);
    throw new Error('Specialty not found');
  }

  // Check for active doctors in this specialty
  const activeDoctorsCount = await Doctor.countDocuments({
    specialtyId: specialty._id,
    verificationStatus: 'verified',
    isActive: true,
  });

  if (activeDoctorsCount > 0) {
    res.status(400);
    throw new Error('Cannot delete specialty with active doctors');
  }

  specialty.isActive = false;
  await specialty.save();

  res.json({
    success: true,
    message: 'Specialty deactivated',
  });
});

module.exports = {
  getSpecialties,
  createSpecialty,
  updateSpecialty,
  deleteSpecialty,
};