const doctorService = require('../services/doctorService');
const Clinic = require('../models/Clinic');
const ClinicTiming = require('../models/ClinicTiming');

// @desc    Get all doctors (with filters, sorting, availability)
// @route   GET /api/v1/healthcare/doctors
// @access  Public
const getDoctors = async (req, res, next) => {
  try {
    const {
      specialtyId,
      availability,
      minFee,
      maxFee,
      consultationType,
      city,
      sortBy,
      page = 1,
      limit = 10,
    } = req.query;

    const result = await doctorService.getDoctors(
      { specialtyId, availability, minFee, maxFee, consultationType, city },
      { sortBy, page: Number(page), limit: Number(limit) }
    );

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// @desc    Search doctors by name or specialty
// @route   GET /api/v1/healthcare/doctors/search
// @access  Public
const searchDoctors = async (req, res, next) => {
  try {
    const { q, limit = 10 } = req.query;

    if (!q || q.trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Search query must be at least 2 characters',
      });
    }

    const results = await doctorService.searchDoctors(q.trim(), Number(limit));

    res.json({
      success: true,
      count: results.length,
      data: results,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get featured (top-rated) doctors
// @route   GET /api/v1/healthcare/doctors/featured
// @access  Public
const getFeaturedDoctors = async (req, res, next) => {
  try {
    const doctors = await doctorService.getFeaturedDoctors();

    res.json({
      success: true,
      count: doctors.length,
      data: doctors,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single doctor with clinics, timings, and 7-day availability
// @route   GET /api/v1/healthcare/doctors/:doctorId
// @access  Public
const getDoctor = async (req, res, next) => {
  try {
    const doctor = await doctorService.getDoctorById(req.params.doctorId);

    if (!doctor) {
      return res.status(404).json({
        success: false,
        error: 'Doctor not found or not currently active',
      });
    }

    res.json({ success: true, data: doctor });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({ success: false, error: 'Invalid doctor ID format' });
    }
    next(error);
  }
};

// @desc    Register as a doctor
// @route   POST /api/v1/healthcare/doctors/register
// @access  Private
const registerDoctor = async (req, res, next) => {
  try {
    const existing = await doctorService.findDoctorByUserId(req.user._id);
    if (existing) {
      return res.status(400).json({
        success: false,
        error: 'Doctor profile already exists for this account',
      });
    }

    const {
      specialtyId,
      pmcNumber,
      qualifications,
      experience,
      about,
      consultationFee,
      videoConsultationFee,
    } = req.body;

    if (!specialtyId || !pmcNumber) {
      return res.status(400).json({
        success: false,
        error: 'Specialty and PMC number are required',
      });
    }

    const doctor = await doctorService.createDoctor({
      userId: req.user._id,
      specialtyId,
      pmcNumber,
      qualifications: qualifications || [],
      experience: experience || 0,
      about: about || '',
      consultationFee: consultationFee || 0,
      videoConsultationFee: videoConsultationFee || 0,
    });

    res.status(201).json({ success: true, data: doctor });
  } catch (error) {
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({
        success: false,
        error: `A doctor with this ${field === 'pmcNumber' ? 'PMC number' : 'account'} already exists`,
      });
    }
    next(error);
  }
};

// @desc    Update doctor profile
// @route   PUT /api/v1/healthcare/doctors/profile
// @access  Private/Doctor
const updateDoctorProfile = async (req, res, next) => {
  try {
    const allowedFields = [
      'qualifications', 'experience', 'about',
      'consultationFee', 'videoConsultationFee',
    ];
    const updates = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    const doctor = await doctorService.updateDoctor(req.doctor._id, updates);
    res.json({ success: true, data: doctor });
  } catch (error) {
    next(error);
  }
};

// @desc    Get my doctor profile
// @route   GET /api/v1/healthcare/doctors/me
// @access  Private
const getMyProfile = async (req, res, next) => {
  try {
    const doctor = await doctorService.getDoctorById(
      (await doctorService.findDoctorByUserId(req.user._id))?._id
    );

    if (!doctor) {
      return res.status(404).json({ success: false, error: 'Doctor profile not found' });
    }

    res.json({ success: true, data: doctor });
  } catch (error) {
    next(error);
  }
};

// @desc    Add clinic to doctor
// @route   POST /api/v1/healthcare/doctors/clinics
// @access  Private/Doctor
const addClinic = async (req, res, next) => {
  try {
    const { name, address, city, area, location, phone } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, error: 'Clinic name is required' });
    }

    const clinic = await Clinic.create({
      doctorId: req.doctor._id,
      name,
      address,
      city,
      area,
      location,
      phone,
    });

    res.status(201).json({ success: true, data: clinic });
  } catch (error) {
    next(error);
  }
};

// @desc    Update clinic
// @route   PUT /api/v1/healthcare/doctors/clinics/:clinicId
// @access  Private/Doctor
const updateClinic = async (req, res, next) => {
  try {
    const clinic = await Clinic.findOneAndUpdate(
      { _id: req.params.clinicId, doctorId: req.doctor._id },
      req.body,
      { new: true, runValidators: true }
    );

    if (!clinic) {
      return res.status(404).json({ success: false, error: 'Clinic not found' });
    }

    res.json({ success: true, data: clinic });
  } catch (error) {
    next(error);
  }
};

// @desc    Set clinic timings (replaces all existing timings for the clinic)
// @route   PUT /api/v1/healthcare/doctors/clinics/:clinicId/timings
// @access  Private/Doctor
const setClinicTimings = async (req, res, next) => {
  try {
    const clinic = await Clinic.findOne({
      _id: req.params.clinicId,
      doctorId: req.doctor._id,
    });

    if (!clinic) {
      return res.status(404).json({ success: false, error: 'Clinic not found' });
    }

    if (!req.body.timings || !Array.isArray(req.body.timings)) {
      return res.status(400).json({ success: false, error: 'timings array is required' });
    }

    // Replace all timings
    await ClinicTiming.deleteMany({ clinicId: clinic._id });
    const timings = await ClinicTiming.insertMany(
      req.body.timings.map((t) => ({ ...t, clinicId: clinic._id }))
    );

    res.json({ success: true, count: timings.length, data: timings });
  } catch (error) {
    next(error);
  }
};

// @desc    Get clinics for a specific doctor with timings
// @route   GET /api/v1/healthcare/doctors/:doctorId/clinics
// @access  Public
const getDoctorClinics = async (req, res, next) => {
  try {
    const clinics = await Clinic.find({
      doctorId: req.params.doctorId,
      isActive: true,
    }).lean();

    if (clinics.length === 0) {
      return res.json({ success: true, count: 0, data: [] });
    }

    // Fetch timings for all clinics in one query
    const clinicIds = clinics.map((c) => c._id);
    const timings = await ClinicTiming.find({ clinicId: { $in: clinicIds } }).lean();

    const clinicsWithTimings = clinics.map((clinic) => ({
      ...clinic,
      id: clinic._id,
      timings: timings
        .filter((t) => t.clinicId.toString() === clinic._id.toString())
        .map((t) => ({ ...t, id: t._id })),
    }));

    res.json({
      success: true,
      count: clinicsWithTimings.length,
      data: clinicsWithTimings,
    });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({ success: false, error: 'Invalid doctor ID' });
    }
    next(error);
  }
};

module.exports = {
  getDoctors,
  searchDoctors,
  getFeaturedDoctors,
  getDoctor,
  registerDoctor,
  updateDoctorProfile,
  getMyProfile,
  addClinic,
  updateClinic,
  setClinicTimings,
  getDoctorClinics,
};
