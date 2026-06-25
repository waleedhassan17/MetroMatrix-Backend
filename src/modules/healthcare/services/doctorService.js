const mongoose = require('mongoose');
const Doctor = require('../models/Doctor');
const Clinic = require('../models/Clinic');
const ClinicTiming = require('../models/ClinicTiming');
const Slot = require('../models/Slot');

/**
 * Build a date range object for availability queries.
 */
const getAvailabilityDateRange = (availability) => {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (availability) {
    case 'today': {
      const endOfToday = new Date(startOfToday);
      endOfToday.setHours(23, 59, 59, 999);
      return { $gte: startOfToday, $lte: endOfToday };
    }
    case 'tomorrow': {
      const startOfTomorrow = new Date(startOfToday);
      startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
      const endOfTomorrow = new Date(startOfTomorrow);
      endOfTomorrow.setHours(23, 59, 59, 999);
      return { $gte: startOfTomorrow, $lte: endOfTomorrow };
    }
    case 'this-week': {
      const endOfWeek = new Date(startOfToday);
      endOfWeek.setDate(endOfWeek.getDate() + (7 - endOfWeek.getDay()));
      endOfWeek.setHours(23, 59, 59, 999);
      return { $gte: startOfToday, $lte: endOfWeek };
    }
    default:
      return null;
  }
};

/**
 * Get doctors with filtering, sorting, and availability check.
 */
const getDoctors = async (filters = {}, options = {}) => {
  const {
    specialtyId,
    availability,
    minFee,
    maxFee,
    consultationType,
    city,
  } = filters;
  const { sortBy = 'rating', page = 1, limit = 10 } = options;
  const skip = (page - 1) * Number(limit);

  // --- Base filter ---
  const query = { verificationStatus: 'verified', isActive: true };

  if (specialtyId) {
    query.specialtyId = new mongoose.Types.ObjectId(specialtyId);
  }

  // Fee filter
  if (minFee || maxFee) {
    query.consultationFee = {};
    if (minFee) query.consultationFee.$gte = Number(minFee);
    if (maxFee) query.consultationFee.$lte = Number(maxFee);
  }

  // --- Availability filter: find doctorIds with open slots ---
  let availableDoctorIds = null;
  if (availability) {
    const dateRange = getAvailabilityDateRange(availability);
    if (dateRange) {
      const slotFilter = { status: 'available', date: dateRange };
      if (consultationType) slotFilter.type = consultationType;

      const doctorIdsWithSlots = await Slot.distinct('doctorId', slotFilter);
      availableDoctorIds = doctorIdsWithSlots;
    }
  }

  // Consultation type filter via slots (if no availability filter was used)
  if (consultationType && !availability) {
    const now = new Date();
    const slotFilter = {
      status: 'available',
      date: { $gte: now },
      type: consultationType,
    };
    const doctorIdsWithSlots = await Slot.distinct('doctorId', slotFilter);
    availableDoctorIds = doctorIdsWithSlots;
  }

  if (availableDoctorIds !== null) {
    query._id = { $in: availableDoctorIds };
  }

  // --- City filter: find doctorIds with clinics in given city ---
  if (city) {
    const clinicDoctorIds = await Clinic.distinct('doctorId', {
      city: { $regex: city, $options: 'i' },
      isActive: true,
    });
    if (query._id) {
      // Intersect with availability filter
      const set = new Set(clinicDoctorIds.map((id) => id.toString()));
      query._id.$in = query._id.$in.filter((id) => set.has(id.toString()));
    } else {
      query._id = { $in: clinicDoctorIds };
    }
  }

  // --- Sort ---
  let sort;
  switch (sortBy) {
    case 'experience':
      sort = { experience: -1 };
      break;
    case 'fee_low':
      sort = { consultationFee: 1 };
      break;
    case 'fee_high':
      sort = { consultationFee: -1 };
      break;
    case 'rating':
    default:
      sort = { rating: -1, totalReviews: -1 };
      break;
  }

  // --- Execute ---
  const [doctors, total] = await Promise.all([
    Doctor.find(query)
      .populate('providerId', 'fullName profilePhoto')
      .populate('specialtyId', 'name icon')
      .sort(sort)
      .skip(skip)
      .limit(Number(limit))
      .lean(),
    Doctor.countDocuments(query),
  ]);

  // --- Attach availableToday flag ---
  if (doctors.length > 0) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    const todaySlotDoctorIds = await Slot.distinct('doctorId', {
      doctorId: { $in: doctors.map((d) => d._id) },
      date: { $gte: startOfToday, $lte: endOfToday },
      status: 'available',
    });
    const todaySet = new Set(todaySlotDoctorIds.map((id) => id.toString()));

    doctors.forEach((doc) => {
      doc.id = doc._id;
      doc.availableToday = todaySet.has(doc._id.toString());
    });
  }

  return {
    doctors,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      pages: Math.ceil(total / Number(limit)),
    },
  };
};

/**
 * Search doctors by name or specialty name.
 */
const searchDoctors = async (q, limit = 10) => {
  const regex = new RegExp(q, 'i');

  // Find specialties matching the query
  const Specialty = require('../models/Specialty');
  const matchingSpecialtyIds = await Specialty.distinct('_id', {
    name: regex,
    isActive: true,
  });

  // Find doctors whose specialty matches
  const doctors = await Doctor.find({
    verificationStatus: 'verified',
    isActive: true,
    specialtyId: { $in: matchingSpecialtyIds },
  })
    .populate('providerId', 'fullName profilePhoto')
    .populate('specialtyId', 'name')
    .limit(50)
    .lean();

  // Also search by provider (doctor) name directly
  const Provider = require('../../../models/Provider');
  const matchingProviderIds = await Provider.distinct('_id', {
    providerType: 'doctor',
    fullName: regex,
  });

  const doctorsByProvider = await Doctor.find({
    verificationStatus: 'verified',
    isActive: true,
    providerId: { $in: matchingProviderIds },
  })
    .populate('providerId', 'fullName profilePhoto')
    .populate('specialtyId', 'name')
    .lean();

  // Merge and deduplicate
  const seen = new Set();
  const merged = [];
  [...doctors, ...doctorsByProvider].forEach((doc) => {
    const key = doc._id.toString();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push({
        doctorId: doc._id,
        name: doc.providerId?.fullName || '',
        specialtyName: doc.specialtyId?.name || '',
        profileImage: doc.providerId?.profilePhoto || '',
      });
    }
  });

  return merged.slice(0, Number(limit));
};

/**
 * Get featured doctors (top-rated with sufficient reviews).
 */
const getFeaturedDoctors = async () => {
  return Doctor.find({
    verificationStatus: 'verified',
    isActive: true,
    totalReviews: { $gte: 10 },
  })
    .populate('providerId', 'fullName profilePhoto')
    .populate('specialtyId', 'name icon')
    .sort({ rating: -1 })
    .limit(10)
    .lean()
    .then((docs) =>
      docs.map((d) => ({ ...d, id: d._id }))
    );
};

/**
 * Get full doctor profile with clinics, timings, and 7-day slot availability.
 */
const getDoctorById = async (doctorId) => {
  const doctor = await Doctor.findOne({
    _id: doctorId,
    verificationStatus: 'verified',
    isActive: true,
  })
    .populate('providerId', 'fullName profilePhoto email')
    .populate('specialtyId', 'name icon description')
    .lean();

  if (!doctor) return null;

  // Fetch clinics and timings
  const clinics = await Clinic.find({ doctorId: doctor._id, isActive: true }).lean();
  const clinicIds = clinics.map((c) => c._id);
  const timings = await ClinicTiming.find({ clinicId: { $in: clinicIds } }).lean();

  const clinicsWithTimings = clinics.map((clinic) => ({
    ...clinic,
    id: clinic._id,
    timings: timings
      .filter((t) => t.clinicId.toString() === clinic._id.toString())
      .map((t) => ({ ...t, id: t._id })),
  }));

  // Fetch available slots for the next 7 days
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfWeek = new Date(startOfToday);
  endOfWeek.setDate(endOfWeek.getDate() + 7);
  endOfWeek.setHours(23, 59, 59, 999);

  const slots = await Slot.find({
    doctorId: doctor._id,
    date: { $gte: startOfToday, $lte: endOfWeek },
    status: 'available',
  })
    .populate('clinicId', 'name address')
    .sort({ date: 1, startTime: 1 })
    .lean();

  // Group slots by date → then by clinicId
  const slotsByDate = {};
  slots.forEach((slot) => {
    const dateKey = slot.date.toISOString().split('T')[0]; // YYYY-MM-DD
    if (!slotsByDate[dateKey]) slotsByDate[dateKey] = {};

    const clinicKey = slot.clinicId
      ? slot.clinicId._id.toString()
      : 'video';
    if (!slotsByDate[dateKey][clinicKey]) {
      slotsByDate[dateKey][clinicKey] = {
        clinic: slot.clinicId || null,
        slots: [],
      };
    }
    slotsByDate[dateKey][clinicKey].slots.push({
      ...slot,
      id: slot._id,
    });
  });

  // Convert to array format for easier frontend consumption
  const availability = Object.entries(slotsByDate).map(([date, clinicGroups]) => ({
    date,
    clinics: Object.values(clinicGroups),
  }));

  return {
    ...doctor,
    id: doctor._id,
    clinics: clinicsWithTimings,
    availability,
  };
};

/**
 * Find doctor by providerId (for auth-related lookups).
 */
const findDoctorByProviderId = async (providerId) => {
  return Doctor.findOne({ providerId });
};

/**
 * Register a new doctor.
 */
const createDoctor = async (data) => {
  return Doctor.create(data);
};

/**
 * Update doctor profile.
 */
const updateDoctor = async (id, data) => {
  return Doctor.findByIdAndUpdate(id, data, { new: true, runValidators: true });
};

module.exports = {
  getDoctors,
  searchDoctors,
  getFeaturedDoctors,
  getDoctorById,
  findDoctorByProviderId,
  createDoctor,
  updateDoctor,
};
