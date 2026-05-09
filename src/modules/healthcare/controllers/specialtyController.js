const specialtyService = require('../services/specialtyService');

// @desc    Get all specialties with doctor count
// @route   GET /api/v1/healthcare/specialties
// @access  Public
const getSpecialties = async (req, res, next) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;

    const result = await specialtyService.getSpecialties(
      { search },
      { page: Number(page), limit: Number(limit) }
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single specialty by ID
// @route   GET /api/v1/healthcare/specialties/:id
// @access  Public
const getSpecialty = async (req, res, next) => {
  try {
    const specialty = await specialtyService.getSpecialtyById(req.params.id);

    if (!specialty) {
      return res.status(404).json({ success: false, error: 'Specialty not found' });
    }

    res.json({ success: true, data: specialty });
  } catch (error) {
    // Handle invalid ObjectId (CastError from Mongoose, BSONError from driver)
    if (error.name === 'CastError' || error.name === 'BSONError' || error.name === 'BSONTypeError' || error.message?.includes('ObjectId') || error.message?.includes('hex string')) {
      return res.status(400).json({ success: false, error: 'Invalid specialty ID' });
    }
    next(error);
  }
};

// @desc    Create specialty (Admin)
// @route   POST /api/v1/healthcare/specialties
// @access  Private/Admin
const createSpecialty = async (req, res, next) => {
  try {
    const { name, icon, description } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Specialty name is required' });
    }

    const specialty = await specialtyService.createSpecialty({ name: name.trim(), icon, description });
    res.status(201).json({ success: true, data: specialty });
  } catch (error) {
    // Handle duplicate name
    if (error.code === 11000) {
      return res.status(400).json({ success: false, error: 'Specialty with this name already exists' });
    }
    next(error);
  }
};

// @desc    Update specialty (Admin)
// @route   PUT /api/v1/healthcare/specialties/:id
// @access  Private/Admin
const updateSpecialty = async (req, res, next) => {
  try {
    const specialty = await specialtyService.updateSpecialty(req.params.id, req.body);

    if (!specialty) {
      return res.status(404).json({ success: false, error: 'Specialty not found' });
    }

    res.json({ success: true, data: specialty });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, error: 'Specialty with this name already exists' });
    }
    next(error);
  }
};

// @desc    Delete (deactivate) specialty (Admin)
// @route   DELETE /api/v1/healthcare/specialties/:id
// @access  Private/Admin
const deleteSpecialty = async (req, res, next) => {
  try {
    const specialty = await specialtyService.deleteSpecialty(req.params.id);

    if (!specialty) {
      return res.status(404).json({ success: false, error: 'Specialty not found' });
    }

    res.json({ success: true, message: 'Specialty deactivated successfully' });
  } catch (error) {
    next(error);
  }
};

module.exports = { getSpecialties, getSpecialty, createSpecialty, updateSpecialty, deleteSpecialty };
