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

/** Escape user input before it becomes a RegExp. */
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Reduce a query to the stem it shares with a specialty name.
 *
 * Patients type the PRACTITIONER ("Neurologist"); specialties are stored as the
 * FIELD ("Neurology"). A plain substring match therefore fails in the direction
 * users actually search: "Neurology" does not contain "Neurologist". Every
 * specialty chip in the app searched this way, and five of six returned nothing
 * — only "Orthopedic" worked, coincidentally, because it IS a substring of
 * "Orthopedics".
 *
 * Trimming the practitioner/plural suffix leaves a root both spellings share:
 *   Neurologist  -> neurolog   (matches Neurology)
 *   Cardiologist -> cardiolog  (matches Cardiology)
 *   Pediatrician -> pediatric  (matches Pediatrics)
 *   Dermatology  -> dermatolog (matches Dermatology)
 *   Orthopedics  -> orthoped   (matches Orthopedics)
 *
 * Order matters: longer suffixes are tested first, so "Neurologist" loses
 * "ologist" rather than just the trailing "ist". Deliberately not a stemming
 * library or fuzzy score — this is a bounded, predictable transform, and a
 * loose matcher on a doctor search returns confidently wrong specialists.
 */
const SPECIALTY_SUFFIXES = ['ologists', 'ologist', 'ology', 'icians', 'ician', 'ists', 'ist', 'ics', 'ic', 's'];

const specialtyStem = (q) => {
  const cleaned = String(q).trim().toLowerCase();
  for (const suffix of SPECIALTY_SUFFIXES) {
    // Keep a meaningful root; "ENT" or "eye" must not be stemmed to nothing.
    if (cleaned.endsWith(suffix) && cleaned.length - suffix.length >= 4) {
      return cleaned.slice(0, cleaned.length - suffix.length);
    }
  }
  return cleaned;
};

/**
 * Search doctors by name or specialty name.
 */
const searchDoctors = async (q, limit = 10) => {
  // `q` was interpolated into a RegExp unescaped: a query of '[' threw a
  // SyntaxError and returned a 500, and '(a+)+$' could pin the event loop.
  const regex = new RegExp(escapeRegex(q), 'i');

  // Matched against the stem so a practitioner noun finds its field. Anchored
  // at the start: "cardiolog" should reach Cardiology, but a stray short stem
  // must not match every specialty containing those letters mid-word.
  const specialtyRegex = new RegExp('^' + escapeRegex(specialtyStem(q)), 'i');

  // Find specialties matching the query
  const Specialty = require('../models/Specialty');
  const matchingSpecialtyIds = await Specialty.distinct('_id', {
    // Either spelling wins: the raw query still matches a specialty typed in
    // full, and the stem catches the practitioner form.
    $or: [{ name: regex }, { name: specialtyRegex }],
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
