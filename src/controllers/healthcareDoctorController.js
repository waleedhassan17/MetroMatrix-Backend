const asyncHandler = require('express-async-handler');
const bcrypt = require('bcryptjs');
const Provider = require('../models/Provider');
// Canonical healthcare models live in the healthcare module.
const paymentService = require('../modules/healthcare/services/paymentService');
const Doctor = require('../modules/healthcare/models/Doctor');
const Specialty = require('../modules/healthcare/models/Specialty');
const Clinic = require('../modules/healthcare/models/Clinic');
const Appointment = require('../modules/healthcare/models/Appointment');
const Slot = require('../modules/healthcare/models/Slot');
const Review = require('../modules/healthcare/models/Review');
const Prescription = require('../modules/healthcare/models/Prescription');
const MedicalNote = require('../modules/healthcare/models/MedicalNote');
const Notification = require('../models/Notification');
const hcNotificationService = require('../modules/healthcare/services/notificationService');
const { generateTokens } = require('../utils/generateToken');
const User = require('../models/User');
const mongoose = require('mongoose');

// Best-effort patient notification (never breaks the request).
const notifyPatient = async (userId, type, title, message, data = {}) => {
  try {
    await hcNotificationService.createNotification({ userId, type, title, message, data });
  } catch (err) {
    console.error('notifyPatient failed:', err.message);
  }
};

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

  // 5. Create admin notification (broadcast to admins; best-effort)
  try {
    await Notification.create({
      type: 'doctor_verification',
      title: 'New Doctor Verification',
      message: `Dr. ${req.user.fullName || 'Unknown'} has submitted verification documents.`,
      data: { providerId },
    });
  } catch (err) {
    console.error('admin notification failed:', err.message);
  }

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

  const slots = await Slot.find({
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
        const overlapping = await Slot.findOne({
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

  await Slot.insertMany(createdSlots);

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
  const slots = await Slot.find({
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
  await Slot.updateMany(
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

  const slot = await Slot.findOne({ _id: req.params.slotId, doctorId: doctor._id });
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

  const { isAvailable, unavailableFrom, unavailableTo, reason, weeklyAvailability, absentDates } = req.body;

  if (typeof isAvailable === 'boolean') {
    doctor.isAvailable = isAvailable;
  }
  if (unavailableFrom) doctor.unavailableFrom = new Date(unavailableFrom);
  if (unavailableTo) doctor.unavailableTo = new Date(unavailableTo);
  if (Array.isArray(weeklyAvailability)) doctor.weeklyAvailability = weeklyAvailability;

  // Detect newly-added absent dates so we can free up / block their slots.
  let newlyAbsent = [];
  if (Array.isArray(absentDates)) {
    const lk = (d) => new Date(d).toLocaleDateString('en-CA');
    const prev = new Set((doctor.absentDates || []).map(lk));
    const next = absentDates.map((d) => { const dt = new Date(d); dt.setHours(0, 0, 0, 0); return dt; });
    newlyAbsent = next.filter((d) => !prev.has(lk(d)));
    doctor.absentDates = next;
  }
  await doctor.save();

  // Block (and cancel booked) slots on newly-absent dates, notifying patients.
  for (const day of newlyAbsent) {
    const start = new Date(day); start.setHours(0, 0, 0, 0);
    const end = new Date(day); end.setHours(23, 59, 59, 999);
    const daySlots = await Slot.find({ doctorId: doctor._id, date: { $gte: start, $lte: end } });
    const booked = daySlots.filter((s) => s.status === 'booked').map((s) => s._id);
    if (booked.length > 0) {
      const appts = await Appointment.find({ slotId: { $in: booked }, status: { $in: ['pending', 'confirmed'] } });
      for (const appt of appts) {
        appt.status = 'cancelled';
        appt.cancellationReason = reason || 'Doctor unavailable on this date';
        appt.cancelledBy = 'doctor';
        await appt.save();
        await notifyPatient(appt.patientId, 'appointment_cancelled', 'Appointment Cancelled',
          'Your appointment was cancelled because the doctor is unavailable on that date.', { appointmentId: appt._id });
      }
    }
    await Slot.updateMany({ doctorId: doctor._id, date: { $gte: start, $lte: end } }, { status: 'blocked' });
  }

  // If setting unavailable and range provided, block slots and notify patients
  if (isAvailable === false && doctor.unavailableFrom && doctor.unavailableTo) {
    const from = doctor.unavailableFrom;
    const to = doctor.unavailableTo;

    // Find all slots in range (any status)
    const slotsInRange = await Slot.find({
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
        await notifyPatient(
          appt.patientId,
          'appointment_cancelled',
          'Appointment Cancelled',
          'Your appointment has been cancelled because the doctor is unavailable.',
          { appointmentId: appt._id }
        );
      }
    }

    // Block all slots (both booked and non-booked)
    await Slot.updateMany(
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
      weeklyAvailability: updatedDoctor.weeklyAvailability || [],
      absentDates: updatedDoctor.absentDates || [],
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
      weeklyAvailability: doctor.weeklyAvailability || [],
      absentDates: doctor.absentDates || [],
    },
  });
});

// @desc    Get my appointments (filtered)
// @route   GET /api/v1/healthcare/doctors/me/appointments
// @access  Private (Provider)
const getMyAppointments = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  const { status, date, page = 1, limit = 10 } = req.query;
  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const query = { doctorId: doctor._id };

  // Status filter
  if (status) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (status === 'upcoming') {
      query.status = { $in: ['pending', 'confirmed'] };
      // Only upcoming means slot date >= today
      // We'll filter after populating slot date – we need a virtual or aggregation.
      // But easier: we'll fetch all matching and filter in memory after populate, or we can use aggregation with $lookup. 
      // Let's use aggregation for proper date filtering.
      // For simplicity, we'll skip date filter in DB and do post-filter (not optimal but works).
    } else if (status === 'past') {
      query.$or = [{ status: 'completed' }];
      // Also appointments with date < today
      // We'll do similar workaround.
    } else if (status === 'cancelled') {
      query.status = 'cancelled';
    }
  }

  // For proper date filtering we'll use aggregation. But to avoid complexity, we'll use .find and populate, then filter.
  let appointments = await Appointment.find(query)
    .populate('patientId', 'fullName profilePhoto')
    .populate('slotId', 'startTime endTime date') // slotId is Slot
    .populate('clinicId', 'name')
    .sort({ createdAt: -1 });

  // Filter by date if provided (exact date match)
  if (date) {
    const filterDate = new Date(date);
    appointments = appointments.filter(appt => {
      if (!appt.slotId) return false;
      const slotDate = new Date(appt.slotId.date);
      return slotDate.toDateString() === filterDate.toDateString();
    });
  }

  // Further filter based on status category
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const filtered = appointments.filter(appt => {
    const slotDate = appt.slotId ? new Date(appt.slotId.date) : null;
    if (status === 'upcoming') {
      return slotDate && slotDate >= today;
    } else if (status === 'past') {
      return (appt.status === 'completed') || (slotDate && slotDate < today);
    } else {
      return true; // cancelled or all
    }
  });

  // Pagination
  const total = filtered.length;
  const start = (pageNum - 1) * limitNum;
  const paged = filtered.slice(start, start + limitNum);

  // Counts
  const todayAppointments = filtered.filter(appt => {
    const d = appt.slotId && new Date(appt.slotId.date);
    return d && d.toDateString() === today.toDateString();
  }).length;
  const upcomingCount = filtered.filter(appt => 
    ((appt.status === 'pending' || appt.status === 'confirmed') && appt.slotId && new Date(appt.slotId.date) >= today)
  ).length;

  res.json({
    success: true,
    data: {
      appointments: paged,
      todayCount: todayAppointments,
      upcomingCount,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    },
  });
});

// @desc    Get a single appointment detail with patient history
// @route   GET /api/v1/healthcare/doctors/me/appointments/:appointmentId
// @access  Private (Provider)
const getAppointmentDetail = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  const appointment = await Appointment.findOne({
    _id: req.params.appointmentId,
    doctorId: doctor._id,
  })
    .populate('patientId', 'fullName profilePhoto phone')
    .populate('slotId', 'startTime endTime date')
    .populate('clinicId', 'name address')
    .populate('doctorId', 'specialtyId'); // populate for doctor info? Not necessary but can.

  if (!appointment) {
    res.status(404);
    throw new Error('Appointment not found');
  }

  // Find previous appointments of this patient with this doctor (completed/cancelled)
  const previousAppointments = await Appointment.find({
    patientId: appointment.patientId._id,
    doctorId: doctor._id,
    _id: { $ne: appointment._id },
    status: { $in: ['completed', 'cancelled'] },
  })
    .populate('slotId', 'date startTime endTime')
    .sort({ 'slotId.date': -1 })
    .limit(5);

  res.json({
    success: true,
    data: {
      appointment,
      patientHistory: previousAppointments,
    },
  });
});

// @desc    Confirm a pending appointment
// @route   PATCH /api/v1/healthcare/doctors/me/appointments/:id/confirm
// @access  Private (Provider)
const confirmAppointment = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  const appointment = await Appointment.findOne({
    _id: req.params.id,
    doctorId: doctor._id,
  });

  if (!appointment) {
    res.status(404);
    throw new Error('Appointment not found');
  }

  if (appointment.status !== 'pending') {
    res.status(400);
    throw new Error('Only pending appointments can be confirmed');
  }

  appointment.status = 'confirmed';
  await appointment.save();

  // Notify patient
  await notifyPatient(
    appointment.patientId,
    'appointment_confirmed',
    'Appointment Confirmed',
    `Your appointment with Dr. ${req.user.fullName || 'your doctor'} has been confirmed.`,
    { appointmentId: appointment._id }
  );

  const updatedAppointment = await Appointment.findById(appointment._id)
    .populate('patientId', 'fullName profilePhoto')
    .populate('slotId', 'startTime endTime date');

  res.json({
    success: true,
    data: { appointment: updatedAppointment },
  });
});

// @desc    Complete a confirmed appointment
// @route   PATCH /api/v1/healthcare/doctors/me/appointments/:id/complete
// @access  Private (Provider)
const completeAppointment = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  const appointment = await Appointment.findOne({
    _id: req.params.id,
    doctorId: doctor._id,
  });

  if (!appointment) {
    res.status(404);
    throw new Error('Appointment not found');
  }

  if (appointment.status !== 'confirmed') {
    res.status(400);
    throw new Error('Only confirmed appointments can be completed');
  }

  // Verify appointment date is today or in the past
  const slot = await Slot.findById(appointment.slotId);
  if (!slot) {
    res.status(400);
    throw new Error('Associated time slot not found');
  }

  // Slot dates are stored at UTC midnight while clients may be up to UTC+14.
  // Allow completion once the slot date has started anywhere on Earth:
  // reject only when the slot is MORE than one server-day ahead.
  const slotDate = new Date(slot.date);
  slotDate.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  if (slotDate > tomorrow) {
    res.status(400);
    throw new Error('Cannot complete a future appointment');
  }

  appointment.status = 'completed';
  appointment.completedAt = new Date();
  await appointment.save();

  // H2: capture cash-at-clinic payment and credit the doctor's earnings
  // ledger (fee minus platform commission) — payout happens at completion,
  // never at payment time.
  try {
    await paymentService.settleCompletedAppointment(appointment);
  } catch (settleErr) {
    console.error('Payout settlement failed:', settleErr.message);
  }

  // Notify patient
  await notifyPatient(
    appointment.patientId,
    'appointment_completed',
    'Appointment Completed',
    'Please share your feedback by leaving a review.',
    { appointmentId: appointment._id }
  );

  const updatedAppointment = await Appointment.findById(appointment._id)
    .populate('patientId', 'fullName profilePhoto')
    .populate('slotId', 'startTime endTime date');

  res.json({
    success: true,
    data: { appointment: updatedAppointment },
  });
});

// @desc    Cancel an appointment (doctor)
// @route   PATCH /api/v1/healthcare/doctors/me/appointments/:id/cancel
// @access  Private (Provider)
const cancelAppointment = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  const { reason } = req.body;
  if (!reason) {
    res.status(400);
    throw new Error('Cancellation reason is required');
  }

  const appointment = await Appointment.findOne({
    _id: req.params.id,
    doctorId: doctor._id,
  });

  if (!appointment) {
    res.status(404);
    throw new Error('Appointment not found');
  }

  if (!['pending', 'confirmed'].includes(appointment.status)) {
    res.status(400);
    throw new Error('Can only cancel pending or confirmed appointments');
  }

  // Update appointment
  appointment.status = 'cancelled';
  appointment.cancellationReason = reason;
  appointment.cancelledBy = 'doctor';
  await appointment.save();

  // H2: doctor-initiated cancellation always refunds the patient in full
  let refunded = 0;
  try {
    refunded = await paymentService.refundAppointment(appointment, {
      cancelledBy: 'doctor',
      reason: `Refund: appointment cancelled by doctor (${reason})`,
    });
  } catch (refundErr) {
    console.error('Refund failed:', refundErr.message);
  }

  // Update time slot
  const slot = await Slot.findById(appointment.slotId);
  if (slot) {
    if (slot.bookedCount > 0) {
      slot.bookedCount -= 1;
    }
    if (slot.bookedCount === 0 && slot.status !== 'blocked') {
      slot.status = 'available';
    }
    await slot.save();
  }

  // Notify patient
  await notifyPatient(
    appointment.patientId,
    'appointment_cancelled',
    'Appointment Cancelled',
    refunded > 0
      ? `Your appointment has been cancelled by the doctor and PKR ${refunded} was refunded to your wallet. Reason: ${reason}`
      : `Your appointment has been cancelled by the doctor. Reason: ${reason}`,
    { appointmentId: appointment._id }
  );

  const updatedAppointment = await Appointment.findById(appointment._id)
    .populate('patientId', 'fullName profilePhoto')
    .populate('slotId', 'startTime endTime date');

  res.json({
    success: true,
    data: { appointment: updatedAppointment },
  });
});

// @desc    Create prescription for completed appointment
// @route   POST /api/v1/healthcare/doctors/me/prescriptions
// @access  Private (Provider)
const createPrescription = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  const { appointmentId, diagnosis, symptoms, medications, tests, advice, followUpDate } = req.body;

  if (!appointmentId || !diagnosis) {
    res.status(400);
    throw new Error('appointmentId and diagnosis are required');
  }

  // Verify appointment belongs to doctor and is completed
  const appointment = await Appointment.findOne({
    _id: appointmentId,
    doctorId: doctor._id,
  });
  if (!appointment) {
    res.status(404);
    throw new Error('Appointment not found');
  }
  if (appointment.status !== 'completed') {
    res.status(400);
    throw new Error('Prescription can only be created for completed appointments');
  }

  // Check uniqueness
  const existing = await Prescription.findOne({ appointmentId });
  if (existing) {
    res.status(400);
    throw new Error('A prescription already exists for this appointment');
  }

  const prescription = await Prescription.create({
    appointmentId,
    doctorId: doctor._id,
    patientId: appointment.patientId,
    diagnosis,
    symptoms: symptoms || [],
    medications: medications || [],
    tests: tests || [],
    advice: advice || '',
    followUpDate: followUpDate ? new Date(followUpDate) : undefined,
  });

  // Notify patient
  await notifyPatient(
    appointment.patientId,
    'prescription_ready',
    'Your Prescription is Ready',
    `Dr. ${req.user.fullName || 'your doctor'} has issued a prescription.`,
    { prescriptionId: prescription._id, appointmentId }
  );

  res.status(201).json({
    success: true,
    data: { prescription },
  });
});

// @desc    Update prescription (within 24 hours)
// @route   PATCH /api/v1/healthcare/doctors/me/prescriptions/:id
// @access  Private (Provider)
const updatePrescription = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  const prescription = await Prescription.findOne({
    _id: req.params.id,
    doctorId: doctor._id,
  });
  if (!prescription) {
    res.status(404);
    throw new Error('Prescription not found');
  }

  // 24-hour window check
  const createdTime = new Date(prescription.createdAt).getTime();
  if (Date.now() - createdTime > 24 * 60 * 60 * 1000) {
    res.status(400);
    throw new Error('Prescription can only be updated within 24 hours of creation');
  }

  // Allowed fields
  const allowed = ['diagnosis', 'symptoms', 'medications', 'tests', 'advice'];
  for (const field of allowed) {
    if (req.body[field] !== undefined) {
      prescription[field] = req.body[field];
    }
  }
  if (req.body.followUpDate) {
    prescription.followUpDate = new Date(req.body.followUpDate);
  }

  await prescription.save();

  res.status(200).json({
    success: true,
    data: { prescription },
  });
});

// @desc    List my prescriptions
// @route   GET /api/v1/healthcare/doctors/me/prescriptions
// @access  Private (Provider)
const getMyPrescriptions = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  const { patientName, startDate, endDate, page = 1, limit = 10 } = req.query;

  // Find all prescriptions for this doctor, populate patient and appointment with slot
  let prescriptions = await Prescription.find({ doctorId: doctor._id })
    .populate({
      path: 'patientId',
      select: 'fullName',
    })
    .populate({
      path: 'appointmentId',
      populate: { path: 'slotId', select: 'date' },
      select: 'slotId',
    })
    .sort({ createdAt: -1 });

  // Client-side filtering (acceptable for FYP scale)
  if (patientName) {
    const regex = new RegExp(patientName, 'i');
    prescriptions = prescriptions.filter(p =>
      p.patientId && p.patientId.fullName && regex.test(p.patientId.fullName)
    );
  }

  if (startDate || endDate) {
    const s = startDate ? new Date(startDate) : new Date(0);
    const e = endDate ? new Date(endDate) : new Date('2100-01-01');
    e.setHours(23, 59, 59, 999);
    prescriptions = prescriptions.filter(p => {
      const date = p.appointmentId && p.appointmentId.slotId ? new Date(p.appointmentId.slotId.date) : null;
      return date && date >= s && date <= e;
    });
  }

  // Paginate
  const total = prescriptions.length;
  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const start = (pageNum - 1) * limitNum;
  const paged = prescriptions.slice(start, start + limitNum);

  res.status(200).json({
    success: true,
    data: {
      prescriptions: paged,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    },
  });
});

// @desc    Doctor dashboard statistics
// @route   GET /api/v1/healthcare/doctors/me/dashboard
// @access  Private (Provider)
const getDashboard = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart); todayEnd.setDate(todayEnd.getDate() + 1);

  // Compute start/end for week and month
  const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Sunday
  const monthStart = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);

  const stats = await Appointment.aggregate([
    { $match: { doctorId: doctor._id } },
    { $lookup: { from: 'slots', localField: 'slotId', foreignField: '_id', as: 'slot' } },
    { $unwind: '$slot' },
    { $facet: {
      today: [
        { $match: { 'slot.date': { $gte: todayStart, $lt: todayEnd } } },
        { $group: {
          _id: null,
          appointments: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          upcoming: { $sum: { $cond: [{ $in: ['$status', ['pending', 'confirmed']] }, 1, 0] } },
          earnings: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$totalAmount', 0] } },
        } },
      ],
      thisWeek: [
        { $match: { 'slot.date': { $gte: weekStart, $lt: todayEnd } } },
        { $group: {
          _id: null,
          appointments: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          upcoming: { $sum: { $cond: [{ $in: ['$status', ['pending', 'confirmed']] }, 1, 0] } },
          earnings: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$totalAmount', 0] } },
        } },
      ],
      thisMonth: [
        { $match: { 'slot.date': { $gte: monthStart, $lt: todayEnd } } },
        { $group: {
          _id: null,
          appointments: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          upcoming: { $sum: { $cond: [{ $in: ['$status', ['pending', 'confirmed']] }, 1, 0] } },
          earnings: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$totalAmount', 0] } },
        } },
      ],
    } },
  ]);

  // Extract facet results
  const todayStats = stats[0].today[0] || { appointments: 0, completed: 0, upcoming: 0, earnings: 0 };
  const weekStats = stats[0].thisWeek[0] || { appointments: 0, completed: 0, upcoming: 0, earnings: 0 };
  const monthStats = stats[0].thisMonth[0] || { appointments: 0, completed: 0, upcoming: 0, earnings: 0 };

  // Next upcoming appointment today (or future)
  const nextAppointment = await Appointment.findOne({
    doctorId: doctor._id,
    status: { $in: ['pending', 'confirmed'] },
  })
    .populate({ path: 'slotId', match: { date: { $gte: todayStart } }, select: 'date startTime endTime' })
    .populate('patientId', 'fullName')
    .sort({ 'slot.date': 1, 'slot.startTime': 1 })
    .lean();

  // If slot doesn't match, nextAppointment may have slotId=null due to match filter; better to filter separately.
  // Return a shape the frontend appointmentSerializer understands (populated
  // patient + slot times) so the dashboard shows the real patient name/time/type.
  let next = null;
  if (nextAppointment && nextAppointment.slotId) {
    next = {
      appointmentId: nextAppointment._id,
      patientId: nextAppointment.patientId,
      patientInfo: nextAppointment.patientInfo,
      type: nextAppointment.type,
      symptoms: nextAppointment.symptoms,
      date: nextAppointment.slotId.date,
      timeSlot: {
        start: nextAppointment.slotId.startTime,
        end: nextAppointment.slotId.endTime,
      },
    };
  }

  res.json({
    success: true,
    data: {
      doctorName: req.user.fullName || '',
      today: todayStats,
      thisWeek: weekStats,
      thisMonth: monthStats,
      rating: doctor.rating,
      totalReviews: doctor.totalReviews,
      nextAppointment: next,
    },
  });
});

// @desc    Earnings report
// @route   GET /api/v1/healthcare/doctors/me/earnings
// @access  Private (Provider)
const getEarnings = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  const { period = 'daily', startDate, endDate } = req.query;
  const start = startDate ? new Date(startDate) : new Date('1970-01-01');
  const end = endDate ? new Date(endDate) : new Date('2100-01-01');
  end.setHours(23, 59, 59, 999);

  const match = {
    doctorId: doctor._id,
    status: 'completed',
  };

  const earnings = await Appointment.aggregate([
    { $match: match },
    { $lookup: { from: 'slots', localField: 'slotId', foreignField: '_id', as: 'slot' } },
    { $unwind: '$slot' },
    { $match: { 'slot.date': { $gte: start, $lte: end } } },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: period === 'weekly' ? '%Y-W%V' : period === 'monthly' ? '%Y-%m' : '%Y-%m-%d', date: '$slot.date' } },
          type: '$type',
        },
        total: { $sum: '$totalAmount' },
        count: { $sum: 1 },
      },
    },
    {
      $group: {
        _id: '$_id.date',
        types: {
          $push: { type: '$_id.type', total: '$total', count: '$count' },
        },
        totalAmount: { $sum: '$total' },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  res.json({
    success: true,
    data: {
      period,
      breakdown: earnings,
    },
  });
});

// @desc    Get my reviews (from the healthcare Review collection)
// @route   GET /api/v1/healthcare/doctors/me/reviews
// @access  Private (Provider)
const getMyReviews = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  const { rating: ratingFilter, page = 1, limit = 10 } = req.query;
  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const skip = (pageNum - 1) * limitNum;

  const query = { doctorId: doctor._id };
  if (ratingFilter) query.rating = parseInt(ratingFilter);

  const [reviews, total] = await Promise.all([
    Review.find(query)
      .populate('patientId', 'fullName profilePhoto')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    Review.countDocuments(query),
  ]);

  res.json({
    success: true,
    data: {
      reviews,
      averageRating: doctor.rating,
      totalReviews: doctor.totalReviews,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    },
  });
});

// ═══════════════════════════════════════════
//  GENERATE SLOTS FROM WEEKLY AVAILABILITY
// ═══════════════════════════════════════════

// @desc    Generate bookable slots from the doctor's weekly availability for a date range
// @route   POST /api/v1/healthcare/doctors/me/slots/generate
// @access  Private (Provider)
const generateSlotsFromAvailability = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) { res.status(404); throw new Error('Doctor profile not found'); }

  const { startDate, endDate, slotDuration = 30 } = req.body;
  if (!startDate || !endDate) { res.status(400); throw new Error('startDate and endDate are required'); }

  const start = new Date(startDate); start.setHours(0, 0, 0, 0);
  const end = new Date(endDate); end.setHours(0, 0, 0, 0);
  if ((end - start) / (1000 * 60 * 60 * 24) > 60) { res.status(400); throw new Error('Date range cannot exceed 60 days'); }

  // Local (server-timezone) date key to avoid UTC off-by-one when matching dates.
  const localKey = (d) => new Date(d).toLocaleDateString('en-CA');

  const byDay = {};
  (doctor.weeklyAvailability || []).forEach((w) => { byDay[w.day] = w; });
  const absent = new Set((doctor.absentDates || []).map(localKey));

  const toMinutes = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const toTimeStr = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

  const candidates = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateKey = new Date(d); dateKey.setHours(0, 0, 0, 0);
    if (absent.has(localKey(dateKey))) continue;
    const dayName = dateKey.toLocaleDateString('en-US', { weekday: 'long' });
    const w = byDay[dayName];
    if (!w || !w.isWorking) continue;

    const build = (cfg, type, clinicId) => {
      if (!cfg || !cfg.enabled) return;
      (cfg.ranges || []).forEach((range) => {
        if (!range.startTime || !range.endTime) return;
        let cur = toMinutes(range.startTime);
        const stop = toMinutes(range.endTime);
        while (cur + slotDuration <= stop) {
          candidates.push({
            doctorId: doctor._id,
            clinicId: clinicId || null,
            date: new Date(dateKey),
            startTime: toTimeStr(cur),
            endTime: toTimeStr(cur + slotDuration),
            type,
            status: 'available',
            maxPatients: 1,
          });
          cur += slotDuration;
        }
      });
    };
    build(w.online, 'video', null);
    build(w.onsite, 'in-clinic', w.onsite && w.onsite.clinicId);
  }

  // De-duplicate against existing slots (same date + startTime + type).
  const existing = await Slot.find({
    doctorId: doctor._id,
    date: { $gte: start, $lte: new Date(end.getTime() + 86400000) },
  }).select('date startTime type');
  const seen = new Set(existing.map((s) => `${localKey(s.date)}_${s.startTime}_${s.type}`));

  const docs = [];
  for (const c of candidates) {
    const key = `${localKey(c.date)}_${c.startTime}_${c.type}`;
    if (!seen.has(key)) { seen.add(key); docs.push(c); }
  }
  if (docs.length) await Slot.insertMany(docs);

  res.status(201).json({
    success: true,
    message: `${docs.length} slots generated`,
    data: { created: docs.length, candidates: candidates.length },
  });
});

// ═══════════════════════════════════════════
//  MEDICAL NOTES (doctor's private notes per patient)
// ═══════════════════════════════════════════

// @desc    Get a patient's summary + this doctor's notes for them
// @route   GET /api/v1/healthcare/doctors/me/patients/:patientId/notes
const getPatientNotes = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) { res.status(404); throw new Error('Doctor profile not found'); }

  const { patientId } = req.params;
  const [user, notes, lastAppt] = await Promise.all([
    User.findById(patientId).select('fullName'),
    MedicalNote.find({ doctorId: doctor._id, patientId }).sort({ createdAt: -1 }),
    Appointment.findOne({ doctorId: doctor._id, patientId }).sort({ createdAt: -1 }),
  ]);

  const patient = {
    patientId,
    patientName: user?.fullName || lastAppt?.patientInfo?.name || '',
    age: lastAppt?.patientInfo?.age || 0,
    gender: lastAppt?.patientInfo?.gender || '',
    bloodGroup: '',
    allergies: [],
    chronicConditions: [],
  };

  res.json({ success: true, data: { patient, notes } });
});

// @desc    Create a medical note
// @route   POST /api/v1/healthcare/doctors/me/notes
const createNote = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) { res.status(404); throw new Error('Doctor profile not found'); }

  const { appointmentId, title, content, tags, attachments } = req.body;
  let { patientId } = req.body;

  // Derive the patient from the appointment if not explicitly provided.
  if (!patientId && appointmentId) {
    const appt = await Appointment.findOne({ _id: appointmentId, doctorId: doctor._id }).select('patientId');
    if (appt) patientId = appt.patientId;
  }
  if (!patientId) { res.status(400); throw new Error('patientId (or a valid appointmentId) is required'); }

  const note = await MedicalNote.create({
    doctorId: doctor._id,
    patientId,
    appointmentId: appointmentId || null,
    title: title || '',
    content: content || '',
    tags: tags || [],
    attachments: attachments || [],
  });

  res.status(201).json({ success: true, data: { note } });
});

// @desc    Update a medical note (owner doctor only)
// @route   PATCH /api/v1/healthcare/doctors/me/notes/:noteId
const updateNote = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) { res.status(404); throw new Error('Doctor profile not found'); }

  const note = await MedicalNote.findOne({ _id: req.params.noteId, doctorId: doctor._id });
  if (!note) { res.status(404); throw new Error('Note not found'); }

  ['title', 'content', 'tags', 'attachments'].forEach((f) => {
    if (req.body[f] !== undefined) note[f] = req.body[f];
  });
  await note.save();

  res.json({ success: true, data: { note } });
});

// @desc    Delete a medical note (owner doctor only)
// @route   DELETE /api/v1/healthcare/doctors/me/notes/:noteId
const deleteNote = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) { res.status(404); throw new Error('Doctor profile not found'); }

  const note = await MedicalNote.findOneAndDelete({ _id: req.params.noteId, doctorId: doctor._id });
  if (!note) { res.status(404); throw new Error('Note not found'); }

  res.json({ success: true, message: 'Note deleted' });
});

// ═══════════════════════════════════════════
//  PATIENT HISTORY (doctor viewing a patient's record with this doctor)
// ═══════════════════════════════════════════

// @desc    Get a patient's visit history with this doctor
// @route   GET /api/v1/healthcare/doctors/me/patients/:patientId/history
const getPatientHistory = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) { res.status(404); throw new Error('Doctor profile not found'); }

  const { patientId } = req.params;
  const [user, appts] = await Promise.all([
    User.findById(patientId).select('fullName phoneNumber'),
    Appointment.find({ doctorId: doctor._id, patientId })
      .populate('slotId', 'date startTime endTime')
      .sort({ createdAt: -1 }),
  ]);

  const apptIds = appts.map((a) => a._id);
  const prescriptions = await Prescription.find({ appointmentId: { $in: apptIds } });
  const presByAppt = {};
  prescriptions.forEach((p) => { presByAppt[p.appointmentId.toString()] = p; });

  const visits = appts.map((a) => {
    const pres = presByAppt[a._id.toString()];
    return {
      visitId: a._id,
      date: a.slotId?.date || a.createdAt,
      type: a.type,
      diagnosis: pres?.diagnosis || '',
      symptoms: a.symptoms ? [a.symptoms] : [],
      prescriptionId: pres?._id,
      notes: a.cancellationReason || '',
      followUp: pres?.followUpDate || '',
    };
  });

  const last = appts[0];
  res.json({
    success: true,
    data: {
      patientId,
      patientName: user?.fullName || last?.patientInfo?.name || '',
      age: last?.patientInfo?.age || 0,
      gender: last?.patientInfo?.gender || '',
      bloodGroup: '',
      phone: user?.phoneNumber || last?.patientInfo?.phone || '',
      allergies: [],
      chronicConditions: [],
      visits,
    },
  });
});

// ═══════════════════════════════════════════
//  TRANSACTIONS LEDGER (completed appointments)
// ═══════════════════════════════════════════

// @desc    Get this doctor's transaction ledger
// @route   GET /api/v1/healthcare/doctors/me/transactions
const getTransactions = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) { res.status(404); throw new Error('Doctor profile not found'); }

  const appts = await Appointment.find({ doctorId: doctor._id, status: 'completed' })
    .populate('patientId', 'fullName')
    .populate('slotId', 'date')
    .sort({ completedAt: -1, createdAt: -1 });

  const transactions = appts.map((a) => ({
    transactionId: a._id,
    patientName: a.patientId?.fullName || a.patientInfo?.name || '',
    appointmentId: a._id,
    type: a.type,
    amount: a.totalAmount || a.fee || 0,
    method: 'cash',
    status: 'completed',
    date: a.completedAt || a.slotId?.date || a.createdAt,
  }));

  res.json({ success: true, data: { transactions } });
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
  generateSlotsFromAvailability,
  getMyAppointments,
  getAppointmentDetail,
  confirmAppointment,
  completeAppointment,
  cancelAppointment,
  createPrescription,
  updatePrescription,
  getMyPrescriptions,
  getDashboard,
  getEarnings,
  getMyReviews,
  getPatientNotes,
  createNote,
  updateNote,
  deleteNote,
  getPatientHistory,
  getTransactions,
};