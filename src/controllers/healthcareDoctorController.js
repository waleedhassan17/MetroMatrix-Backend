const asyncHandler = require('express-async-handler');
const bcrypt = require('bcryptjs');
const Provider = require('../models/Provider');
const Doctor = require('../models/Doctor');
const Specialty = require('../models/Specialty');
const Clinic = require('../models/Clinic');
const Appointment = require('../models/Appointment');
const TimeSlot = require('../models/TimeSlot');
const Notification = require('../models/Notification');
const { generateTokens } = require('../utils/generateToken');

// @desc    Register a new doctor
// @route   POST /api/v1/healthcare/doctors/register
// @access  Public
const registerDoctor = asyncHandler(async (req, res) => {
  const { email, password, fullName, phoneNumber, pmcNumber, specialtyId, ...rest } = req.body;

  if (!email || !password || !fullName || !phoneNumber || !pmcNumber || !specialtyId) {
    res.status(400);
    throw new Error('Please provide all required fields');
  }

  // Check uniqueness
  const existingProvider = await Provider.findOne({ email: email.toLowerCase() });
  if (existingProvider) {
    res.status(409);
    throw new Error('A provider with this email already exists');
  }
  const existingDoctor = await Doctor.findOne({ pmcNumber });
  if (existingDoctor) {
    res.status(409);
    throw new Error('A doctor with this PMC number already exists');
  }
  const specialtyExists = await Specialty.findById(specialtyId);
  if (!specialtyExists) {
    res.status(404);
    throw new Error('Specialty not found');
  }

  // ✅ FIX: Pass plain password – let the Provider model's pre('save') hash it.
  const provider = await Provider.create({
    email: email.toLowerCase(),
    password,                              // <-- plain text here
    fullName,
    phoneNumber,
    providerType: 'doctor',
    specialty: specialtyId,
    city: rest.city || '',
  });

  const doctor = await Doctor.create({
    providerId: provider._id,
    pmcNumber,
    specialtyId,
    verificationStatus: 'pending',
  });

  const tokens = generateTokens(provider._id, { userType: 'provider' });

  res.status(201).json({
    success: true,
    data: {
      doctor: {
        doctorId: doctor._id,
        email: provider.email,
        name: provider.fullName,
        verificationStatus: doctor.verificationStatus,
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    },
  });
});

// @desc    Sign in existing doctor
// @route   POST /api/v1/healthcare/doctors/signin
// @access  Public
const signinDoctor = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400);
    throw new Error('Please provide email and password');
  }

  // 1. Find Provider with providerType 'doctor'
  const provider = await Provider.findOne({
    email: email.toLowerCase(),
    providerType: 'doctor',
  }).select('+password'); // need password for comparison

  if (!provider) {
    res.status(401);
    throw new Error('Invalid email or password');
  }

  // 2. Check password
  const isMatch = await bcrypt.compare(password, provider.password);
  if (!isMatch) {
    res.status(401);
    throw new Error('Invalid email or password');
  }

  // 3. Load associated Doctor
  const doctor = await Doctor.findOne({ providerId: provider._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  // 4. Generate tokens
  const tokens = generateTokens(provider._id, { userType: 'provider' });

  res.json({
    success: true,
    data: {
      doctor: {
        doctorId: doctor._id,
        email: provider.email,
        name: provider.fullName,
        verificationStatus: doctor.verificationStatus,
        pmcNumber: doctor.pmcNumber,
        specialty: doctor.specialtyId,
        // include other safe fields
      },
      provider: {
        id: provider._id,
        fullName: provider.fullName,
        phoneNumber: provider.phoneNumber,
        isActive: provider.isActive,
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    },
  });
});

// @desc    Submit doctor verification documents
// @route   POST /api/v1/healthcare/doctors/verification
// @access  Private (Provider only)
const submitVerification = asyncHandler(async (req, res) => {
  // req.user is set by protect middleware (providerId)
  const providerId = req.user._id;

  // 1. Find Doctor
  const doctor = await Doctor.findOne({ providerId });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  // 2. Check current verification status
  if (doctor.verificationStatus !== 'pending') {
    res.status(400);
    throw new Error('Documents can only be submitted when status is pending');
  }

  // 3. Extract file URLs from req.files
  // uploadMultipleDocuments middleware populates req.files as an object with field names
  const pmcCertificate = req.files?.pmcCertificate?.[0]?.path;
  const degreesCertificates = req.files?.degreesCertificates?.map(f => f.path) || [];
  const cnicFront = req.files?.cnicFront?.[0]?.path;
  const cnicBack = req.files?.cnicBack?.[0]?.path;

  // Validate required files
  if (!pmcCertificate) {
    res.status(400);
    throw new Error('PMC certificate is required');
  }
  if (!cnicFront || !cnicBack) {
    res.status(400);
    throw new Error('CNIC front and back images are required');
  }
  if (degreesCertificates.length === 0) {
    res.status(400);
    throw new Error('At least one degree certificate is required');
  }

  // 4. Save URLs to doctor record
  doctor.verificationDocuments = {
    pmcCertificate,
    degreesCertificates,
    cnicFront,
    cnicBack,
  };
  doctor.verificationStatus = 'under_review';

  await doctor.save();

  // 5. Create admin notification
  await Notification.create({
    recipientType: 'admin',
    type: 'doctor_verification',
    title: 'New Doctor Verification',
    message: `Dr. ${req.user.fullName || 'Unknown'} has submitted verification documents.`,
    data: {
      doctorId: doctor._id,
      providerId,
    },
  });

  res.json({
    success: true,
    message: 'Verification documents submitted successfully',
    data: {
      verificationStatus: doctor.verificationStatus,
    },
  });
});

// @desc    Get my doctor profile with clinics
// @route   GET /api/v1/healthcare/doctors/me
// @access  Private (Provider)
const getMyProfile = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id })
    .populate('specialtyId', 'name icon')
    .populate('providerId', 'fullName email phone profilePhoto city');

  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  // Fetch active clinics
  const clinics = await Clinic.find({ doctorId: doctor._id, isActive: true });

  res.status(200).json({
    success: true,
    data: {
      doctor: {
        ...doctor.toObject(),
        clinics,
      },
    },
  });
});

// @desc    Update my doctor profile
// @route   PATCH /api/v1/healthcare/doctors/me
// @access  Private (Provider)
const updateMyProfile = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  // Fields allowed on Doctor
  const doctorAllowed = ['about', 'consultationFee', 'videoConsultationFee', 'qualifications', 'experience'];
  for (const field of doctorAllowed) {
    if (req.body[field] !== undefined) {
      doctor[field] = req.body[field];
    }
  }
  await doctor.save();

  // Fields allowed on Provider
  const provider = await Provider.findById(doctor.providerId);
  if (provider) {
    const providerAllowed = ['briefDescription', 'city'];
    let providerChanged = false;
    for (const field of providerAllowed) {
      if (req.body[field] !== undefined) {
        provider[field] = req.body[field];
        providerChanged = true;
      }
    }
    if (providerChanged) {
      await provider.save();
    }
  }

  // Return updated doctor with populated fields
  const updatedDoctor = await Doctor.findById(doctor._id)
    .populate('specialtyId', 'name icon')
    .populate('providerId', 'fullName email phone profilePhoto city briefDescription');

  res.status(200).json({
    success: true,
    data: { doctor: updatedDoctor },
  });
});

// @desc    Upload doctor profile image
// @route   POST /api/v1/healthcare/doctors/me/image
// @access  Private (Provider)
const uploadProfileImage = asyncHandler(async (req, res) => {
  if (!req.file || !req.file.path) {
    res.status(400);
    throw new Error('Please upload an image');
  }

  const provider = await Provider.findByIdAndUpdate(
    req.user._id,
    { profilePhoto: req.file.path },
    { new: true, select: 'profilePhoto fullName' }
  );

  res.status(200).json({
    success: true,
    message: 'Profile image updated',
    data: { profilePhoto: provider.profilePhoto },
  });
});

// @desc    Get my clinics
// @route   GET /api/v1/healthcare/doctors/me/clinics
// @access  Private (Provider)
const getMyClinics = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  const clinics = await Clinic.find({ doctorId: doctor._id, isActive: true });

  res.status(200).json({
    success: true,
    data: { clinics },
  });
});

// @desc    Add a new clinic
// @route   POST /api/v1/healthcare/doctors/me/clinics
// @access  Private (Provider)
const addClinic = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  const { name, address, city, area, coordinates, phone, timings } = req.body;

  if (!name || !address || !city) {
    res.status(400);
    throw new Error('Name, address, and city are required');
  }

  const clinic = await Clinic.create({
    doctorId: doctor._id,
    name,
    address,
    city,
    area,
    coordinates,
    phone,
    timings,
  });

  res.status(201).json({
    success: true,
    data: { clinic },
  });
});

// @desc    Update a clinic
// @route   PATCH /api/v1/healthcare/doctors/me/clinics/:clinicId
// @access  Private (Provider)
const updateClinic = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  const { clinicId } = req.params;
  const clinic = await Clinic.findOne({ _id: clinicId, doctorId: doctor._id });
  if (!clinic) {
    res.status(404);
    throw new Error('Clinic not found or not owned by you');
  }

  // Allowed fields to update
  const allowed = ['name', 'address', 'city', 'area', 'coordinates', 'phone', 'timings'];
  for (const field of allowed) {
    if (req.body[field] !== undefined) {
      clinic[field] = req.body[field];
    }
  }

  await clinic.save();

  res.status(200).json({
    success: true,
    data: { clinic },
  });
});

// @desc    Soft-delete a clinic
// @route   DELETE /api/v1/healthcare/doctors/me/clinics/:clinicId
// @access  Private (Provider)
const deleteClinic = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  const { clinicId } = req.params;
  const clinic = await Clinic.findOne({ _id: clinicId, doctorId: doctor._id, isActive: true });
  if (!clinic) {
    res.status(404);
    throw new Error('Clinic not found or not owned by you');
  }

  // Check for upcoming appointments
  const upcomingAppointments = await Appointment.find({
    clinicId: clinicId,
    status: { $in: ['pending', 'confirmed'] },
  }).populate({
    path: 'slotId',
    select: 'date',
    match: { date: { $gte: new Date() } },
  });

  const hasUpcoming = upcomingAppointments.some(appt => appt.slotId !== null);
  if (hasUpcoming) {
    res.status(400);
    throw new Error('Cannot delete clinic with upcoming appointments');
  }

  // Soft delete
  clinic.isActive = false;
  await clinic.save();

  res.status(200).json({
    success: true,
    message: 'Clinic deleted successfully',
  });
});

// @desc    Get my schedule grouped by date
// @route   GET /api/v1/healthcare/doctors/me/schedule
// @access  Private (Provider)
const getMySchedule = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    res.status(400);
    throw new Error('startDate and endDate are required');
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  const diffDays = (end - start) / (1000 * 60 * 60 * 24);
  if (diffDays > 30) {
    res.status(400);
    throw new Error('Date range cannot exceed 30 days');
  }

  const slots = await TimeSlot.find({
    doctorId: doctor._id,
    date: { $gte: start, $lte: end },
  }).populate('clinicId', 'name');

  // Get appointment IDs for booked slots
  const slotIds = slots.map(s => s._id);
  const appointments = await Appointment.find({
    slotId: { $in: slotIds },
    status: { $in: ['pending', 'confirmed'] },
  });
  const apptMap = {};
  appointments.forEach(a => { apptMap[a.slotId.toString()] = a._id; });

  // Group by date
  const grouped = {};
  slots.forEach(slot => {
    const dateKey = slot.date.toISOString().split('T')[0];
    if (!grouped[dateKey]) grouped[dateKey] = [];
    grouped[dateKey].push({
      slotId: slot._id,
      startTime: slot.startTime,
      endTime: slot.endTime,
      type: slot.type,
      clinicId: slot.clinicId ? slot.clinicId._id : null,
      clinicName: slot.clinicId ? slot.clinicId.name : null,
      status: slot.status,
      bookedCount: slot.bookedCount,
      maxPatients: slot.maxPatients,
      appointment: apptMap[slot._id.toString()] || null,
    });
  });

  const schedule = Object.keys(grouped).sort().map(date => ({
    date,
    slots: grouped[date],
  }));

  res.json({ success: true, data: { schedule } });
});

// @desc    Bulk create time slots
// @route   POST /api/v1/healthcare/doctors/me/slots
// @access  Private (Provider)
const createSlots = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  const {
    clinicId,
    startDate,
    endDate,
    days,          // e.g., ['Monday','Wednesday']
    timeRanges,    // e.g., [{ startTime: '09:00', endTime: '12:00' }]
    slotDuration,  // minutes
    breakBetween,  // minutes
    type,          // 'in-clinic' or 'video'
    maxPatients = 1,
  } = req.body;

  if (!startDate || !endDate || !days || !timeRanges || !slotDuration || !type) {
    res.status(400);
    throw new Error('Required fields: startDate, endDate, days, timeRanges, slotDuration, type');
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  const createdSlots = [];

  // Helper to parse time "HH:MM" to minutes from midnight
  const toMinutes = (timeStr) => {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
  };
  const toTimeStr = (min) => {
    const h = Math.floor(min / 60).toString().padStart(2, '0');
    const m = (min % 60).toString().padStart(2, '0');
    return `${h}:${m}`;
  };

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dayName = d.toLocaleDateString('en-US', { weekday: 'long' });
    if (!days.includes(dayName)) continue;

    const date = new Date(d); // without time

    for (const range of timeRanges) {
      let currentMin = toMinutes(range.startTime);
      const endMin = toMinutes(range.endTime);

      while (currentMin + slotDuration <= endMin) {
        const slotStart = toTimeStr(currentMin);
        const slotEnd = toTimeStr(currentMin + slotDuration);

        // Check overlapping slots for this doctor on this date
        const overlapping = await TimeSlot.findOne({
          doctorId: doctor._id,
          date,
          $or: [
            { startTime: { $lt: slotEnd }, endTime: { $gt: slotStart } },
          ],
        });

        if (!overlapping) {
          createdSlots.push({
            doctorId: doctor._id,
            clinicId: clinicId || undefined,
            date,
            startTime: slotStart,
            endTime: slotEnd,
            type,
            maxPatients,
            status: 'available',
          });
        }

        currentMin += slotDuration + (breakBetween || 0);
      }
    }
  }

  if (createdSlots.length === 0) {
    res.status(400);
    throw new Error('No slots could be created. Check for overlapping slots or invalid parameters.');
  }

  await TimeSlot.insertMany(createdSlots);

  res.status(201).json({
    success: true,
    message: `${createdSlots.length} slots created`,
    data: { createdCount: createdSlots.length },
  });
});

// @desc    Block a time range
// @route   POST /api/v1/healthcare/doctors/me/slots/block
// @access  Private (Provider)
const blockSlots = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  const { date, startTime, endTime, reason } = req.body;
  if (!date || !startTime || !endTime) {
    res.status(400);
    throw new Error('date, startTime, endTime are required');
  }

  const targetDate = new Date(date);

  // Find overlapping slots for this doctor on that date
  const slots = await TimeSlot.find({
    doctorId: doctor._id,
    date: targetDate,
    startTime: { $lt: endTime },
    endTime: { $gt: startTime },
  });

  if (slots.length === 0) {
    res.status(404);
    throw new Error('No slots found in this time range');
  }

  // Check for booked slots
  const bookedSlots = slots.filter(s => s.status === 'booked');
  if (bookedSlots.length > 0) {
    res.status(400);
    throw new Error('Cannot block a time range that contains booked slots');
  }

  // Block all found slots (status = 'blocked')
  await TimeSlot.updateMany(
    { _id: { $in: slots.map(s => s._id) } },
    { status: 'blocked' }
  );

  res.json({
    success: true,
    message: `${slots.length} slot(s) blocked`,
    data: { blockedCount: slots.length },
  });
});

// @desc    Unblock a single slot
// @route   DELETE /api/v1/healthcare/doctors/me/slots/block/:slotId
// @access  Private (Provider)
const unblockSlot = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  const slot = await TimeSlot.findOne({ _id: req.params.slotId, doctorId: doctor._id });
  if (!slot) {
    res.status(404);
    throw new Error('Slot not found');
  }
  if (slot.status !== 'blocked') {
    res.status(400);
    throw new Error('Slot is not blocked');
  }

  slot.status = 'available';
  await slot.save();

  res.json({ success: true, message: 'Slot unblocked' });
});

// @desc    Set availability status
// @route   PATCH /api/v1/healthcare/doctors/me/availability
// @access  Private (Provider)
const setAvailability = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  const { isAvailable, unavailableFrom, unavailableTo, reason } = req.body;

  if (typeof isAvailable === 'boolean') {
    doctor.isAvailable = isAvailable;
  }
  if (unavailableFrom) doctor.unavailableFrom = new Date(unavailableFrom);
  if (unavailableTo) doctor.unavailableTo = new Date(unavailableTo);
  await doctor.save();

  // If setting unavailable and range provided, block slots and notify patients
  if (isAvailable === false && doctor.unavailableFrom && doctor.unavailableTo) {
    const from = doctor.unavailableFrom;
    const to = doctor.unavailableTo;

    // Find all slots in range (any status)
    const slotsInRange = await TimeSlot.find({
      doctorId: doctor._id,
      date: { $gte: from, $lte: to },
    });

    const bookedSlotIds = [];
    const nonBookedSlotIds = [];

    slotsInRange.forEach(s => {
      if (s.status === 'booked') {
        bookedSlotIds.push(s._id);
      } else {
        nonBookedSlotIds.push(s._id);
      }
    });

    // Cancel appointments for booked slots and notify patients
    if (bookedSlotIds.length > 0) {
      const appointments = await Appointment.find({
        slotId: { $in: bookedSlotIds },
        status: { $in: ['pending', 'confirmed'] },
      });

      for (const appt of appointments) {
        appt.status = 'cancelled';
        appt.cancellationReason = reason || 'Doctor unavailable';
        appt.cancelledBy = 'doctor';
        await appt.save();

        // Create notification for patient
        await Notification.create({
          recipientType: 'user',
          userId: appt.patientId,
          type: 'appointment_cancelled',
          title: 'Appointment Cancelled',
          message: `Your appointment on ${appt.scheduledAt || 'selected date'} has been cancelled. Doctor is unavailable.`,
          data: { appointmentId: appt._id },
        });
      }
    }

    // Block all slots (both booked and non-booked)
    await TimeSlot.updateMany(
      { _id: { $in: [...bookedSlotIds, ...nonBookedSlotIds] } },
      { status: 'blocked' }
    );
  }

  // Return latest availability
  const updatedDoctor = await Doctor.findById(doctor._id);
  res.json({
    success: true,
    data: {
      isAvailable: updatedDoctor.isAvailable,
      unavailableFrom: updatedDoctor.unavailableFrom,
      unavailableTo: updatedDoctor.unavailableTo,
    },
  });
});

// @desc    Get availability status
// @route   GET /api/v1/healthcare/doctors/me/availability
// @access  Private (Provider)
const getAvailability = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  res.json({
    success: true,
    data: {
      isAvailable: doctor.isAvailable,
      unavailableFrom: doctor.unavailableFrom,
      unavailableTo: doctor.unavailableTo,
    },
  });
});

module.exports = {
  registerDoctor,
  signinDoctor,
  submitVerification,
  getMyProfile,
  updateMyProfile,
  uploadProfileImage,
  getMyClinics,
  addClinic,
  updateClinic,
  deleteClinic,
  getMySchedule,
  createSlots,
  blockSlots,
  unblockSlot,
  setAvailability,
  getAvailability,
};