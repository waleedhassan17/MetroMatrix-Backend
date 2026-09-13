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
const slotService = require('../modules/healthcare/services/slotService');
const Review = require('../modules/healthcare/models/Review');
const Prescription = require('../modules/healthcare/models/Prescription');
const MedicalNote = require('../modules/healthcare/models/MedicalNote');
const {
  generateForDoctor,
  GenerationLimitError,
  HORIZON_DAYS,
} = require('../modules/healthcare/services/slotGenerationService');
const {
  validateWeeklyAvailability,
  validateSettings,
  ownedClinicIds,
} = require('../modules/healthcare/services/availabilityService');
const appointmentService = require('../modules/healthcare/services/appointmentService');
const { appointmentTimeFields } = require('../modules/healthcare/services/appointmentTime');
const {
  ACTIVE_STATUSES,
  APPOINTMENT_LIST_FIELDS,
  DAY_MS,
  MAX_LIST_LIMIT,
  DASHBOARD_GROUP,
  buildDoctorAppointmentFilter,
  buildEarningsPipeline,
  computeDashboardWindows,
  ensureAppointmentTimes,
  pickStats,
  resolveEarningsWindow,
  summarizeByType,
  toAppointmentListItem,
  toDashboardItem,
} = require('../modules/healthcare/services/doctorQueries');
const {
  todayKey,
  addDays,
  DEFAULT_TIMEZONE,
  localToUtc,
  toDateKey,
  safeZone,
  isDateKey,
  paddedRange,
} = require('../utils/time');
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

/**
 * The signed-in doctor.
 *
 * Routes mounted with attachDoctor() have already loaded it, lean, once per
 * request — every handler here used to repeat `Doctor.findOne({ providerId })`
 * itself, fully hydrated. The handlers that save the doctor document run on
 * routes without attachDoctor and get a hydrated one from the fallback.
 */
const currentDoctor = async (req, res) => {
  const doctor = req.doctor || (await Doctor.findOne({ providerId: req.user._id }));
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }
  return doctor;
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
  const doctor = await currentDoctor(req, res);

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
  const doctor = await currentDoctor(req, res);

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
  const doctor = await currentDoctor(req, res);

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
  const doctor = await currentDoctor(req, res);

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
  const doctor = await currentDoctor(req, res);

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

// @desc    Get my appointments (filtered)
// @route   GET /api/v1/healthcare/doctors/me/appointments
// @access  Private (Provider)
const getMyAppointments = asyncHandler(async (req, res) => {
  const doctor = await currentDoctor(req, res);
  const tz = safeZone(doctor.timezone);
  await ensureAppointmentTimes(doctor._id);

  // Every filter runs in the database against the appointment's own copied
  // time, on an index. This used to load the doctor's ENTIRE appointment
  // history, populate three references per row, then filter by date and page
  // in JavaScript — on every Schedule open and every 30-second queue poll.
  let built;
  try {
    built = buildDoctorAppointmentFilter(doctor._id, req.query, { tz });
  } catch (err) {
    res.status(400);
    throw err;
  }

  const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limitNum = Math.min(MAX_LIST_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const today = todayKey(tz);
  const now = new Date();

  const [rows, total, todayCount, upcomingCount] = await Promise.all([
    Appointment.find(built.filter)
      .select(APPOINTMENT_LIST_FIELDS)
      .populate('patientId', 'fullName profilePhoto')
      .populate('clinicId', 'name')
      .sort(built.sort)
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean(),
    Appointment.countDocuments(built.filter),
    Appointment.countDocuments({
      doctorId: doctor._id,
      ...paddedRange(today, today, tz),
      status: { $ne: 'cancelled' },
    }),
    Appointment.countDocuments({
      doctorId: doctor._id,
      status: { $in: ACTIVE_STATUSES },
      startUtc: { $gt: new Date(now.getTime() - DAY_MS) },
      endUtc: { $gt: now },
    }),
  ]);

  res.json({
    success: true,
    data: {
      appointments: rows.map(toAppointmentListItem),
      // Doctor-wide counts, not counts within the filtered page.
      todayCount,
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
  const doctor = await currentDoctor(req, res);

  const appointment = await Appointment.findOne({
    _id: req.params.appointmentId,
    doctorId: doctor._id,
  })
    .select(APPOINTMENT_LIST_FIELDS)
    .populate('patientId', 'fullName profilePhoto phone phoneNumber')
    .populate('clinicId', 'name address')
    .lean();

  if (!appointment) {
    res.status(404);
    throw new Error('Appointment not found');
  }

  const patientRef = appointment.patientId && appointment.patientId._id
    ? appointment.patientId._id
    : appointment.patientId;

  const [previousAppointments, prescription] = await Promise.all([
    // This patient's earlier visits with this doctor. The old sort was on a
    // populated path ('slotId.date'), which MongoDB cannot sort by, so the
    // "latest five" were in arbitrary order.
    Appointment.find({
      patientId: patientRef,
      doctorId: doctor._id,
      _id: { $ne: appointment._id },
      status: { $in: ['completed', 'cancelled'] },
    })
      .select(APPOINTMENT_LIST_FIELDS)
      .sort({ startUtc: -1 })
      .limit(5)
      .lean(),
    Prescription.findOne({ appointmentId: appointment._id }).select('_id diagnosis createdAt').lean(),
  ]);

  res.json({
    success: true,
    data: {
      appointment: toAppointmentListItem(appointment),
      patientHistory: previousAppointments.map(toAppointmentListItem),
      prescription: prescription
        ? { id: prescription._id, diagnosis: prescription.diagnosis, createdAt: prescription.createdAt }
        : null,
    },
  });
});

// @desc    Confirm a pending appointment
// @route   PATCH /api/v1/healthcare/doctors/me/appointments/:id/confirm
// @access  Private (Provider)
const confirmAppointment = asyncHandler(async (req, res) => {
  const doctor = await currentDoctor(req, res);

  // Conditional on the status, so a double tap confirms (and notifies) once.
  const appointment = await Appointment.findOneAndUpdate(
    { _id: req.params.id, doctorId: doctor._id, status: 'pending' },
    { $set: { status: 'confirmed' } },
    { new: true }
  )
    .select(APPOINTMENT_LIST_FIELDS)
    .populate('patientId', 'fullName profilePhoto')
    .populate('clinicId', 'name')
    .lean();

  if (!appointment) {
    const exists = await Appointment.exists({ _id: req.params.id, doctorId: doctor._id });
    res.status(exists ? 400 : 404);
    throw new Error(exists ? 'Only pending appointments can be confirmed' : 'Appointment not found');
  }

  await notifyPatient(
    appointment.patientId && appointment.patientId._id ? appointment.patientId._id : appointment.patientId,
    'appointment_confirmed',
    'Appointment Confirmed',
    `Your appointment with Dr. ${req.user.fullName || 'your doctor'} has been confirmed.`,
    { appointmentId: appointment._id }
  );

  res.json({
    success: true,
    data: { appointment: toAppointmentListItem(appointment) },
  });
});

// @desc    Complete a confirmed appointment
// @route   PATCH /api/v1/healthcare/doctors/me/appointments/:id/complete
// @access  Private (Provider)
const completeAppointment = asyncHandler(async (req, res) => {
  const doctor = await currentDoctor(req, res);

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

  // Allowed once the appointment's day has begun in its own zone. This read
  // the slot's `date` through the server's clock — UTC on Vercel — while the
  // stored value is clinic midnight, so the boundary was off by hours.
  const tz = safeZone(appointment.timezone);
  let dayKey = appointment.dateKey;
  if (!dayKey) {
    const slot = await Slot.findById(appointment.slotId)
      .select('date dateKey startTime endTime startUtc endUtc clinicTimezone')
      .lean();
    if (!slot) {
      res.status(400);
      throw new Error('Associated time slot not found');
    }
    dayKey = appointmentTimeFields(slot).dateKey;
  }
  if (dayKey && dayKey > todayKey(tz)) {
    res.status(400);
    throw new Error('Cannot complete a future appointment');
  }

  // Conditional on the status, so two taps cannot settle the payout twice.
  const completed = await Appointment.findOneAndUpdate(
    { _id: appointment._id, doctorId: doctor._id, status: 'confirmed' },
    { $set: { status: 'completed', completedAt: new Date() } },
    { new: true }
  );
  if (!completed) {
    res.status(409);
    throw new Error('This appointment was already completed or cancelled');
  }

  // H2: capture cash-at-clinic payment and credit the doctor's earnings
  // ledger (fee minus platform commission) — payout happens at completion,
  // never at payment time.
  try {
    await paymentService.settleCompletedAppointment(completed);
  } catch (settleErr) {
    console.error('Payout settlement failed:', settleErr.message);
  }

  await notifyPatient(
    completed.patientId,
    'appointment_completed',
    'Appointment Completed',
    'Please share your feedback by leaving a review.',
    { appointmentId: completed._id }
  );

  const updated = await Appointment.findById(completed._id)
    .select(APPOINTMENT_LIST_FIELDS)
    .populate('patientId', 'fullName profilePhoto')
    .populate('clinicId', 'name')
    .lean();

  res.json({
    success: true,
    data: { appointment: toAppointmentListItem(updated) },
  });
});

// @desc    Cancel an appointment (doctor)
// @route   PATCH /api/v1/healthcare/doctors/me/appointments/:id/cancel
// @access  Private (Provider)
const cancelAppointment = asyncHandler(async (req, res) => {
  const doctor = await currentDoctor(req, res);

  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason) {
    res.status(400);
    throw new Error('Cancellation reason is required');
  }

  const result = await appointmentService.cancelByDoctor(req.params.id, doctor._id, reason);
  if (result.error) {
    res.status(result.status);
    throw new Error(result.error);
  }

  const updated = await Appointment.findById(result.appointment._id)
    .select(APPOINTMENT_LIST_FIELDS)
    .populate('patientId', 'fullName profilePhoto')
    .populate('clinicId', 'name')
    .lean();

  res.json({
    success: true,
    data: { appointment: toAppointmentListItem(updated), refunded: result.refunded },
  });
});

// @desc    Create prescription for completed appointment
// @route   POST /api/v1/healthcare/doctors/me/prescriptions
// @access  Private (Provider)
const createPrescription = asyncHandler(async (req, res) => {
  const doctor = await currentDoctor(req, res);

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
  const doctor = await currentDoctor(req, res);

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
  const doctor = await currentDoctor(req, res);

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
  const doctor = await currentDoctor(req, res);
  const tz = safeZone(doctor.timezone);
  await ensureAppointmentTimes(doctor._id);

  const now = new Date();
  const { todayKey: today, weekStartKey, monthStartKey } = computeDashboardWindows(now, tz);
  const earliest = weekStartKey < monthStartKey ? weekStartKey : monthStartKey;
  // Bounds the scan for "next" and "requests" to recent instants.
  const recent = { $gt: new Date(now.getTime() - DAY_MS) };

  // One indexed pass over this month (or this week, when it began last month),
  // bucketed by each appointment's own calendar day. This used to $lookup
  // slots for EVERY appointment the doctor ever had, then filter by date; and
  // "next appointment" sorted on a field that does not exist.
  const [facets, todayRows, next, pendingRequests] = await Promise.all([
    Appointment.aggregate([
      { $match: { doctorId: doctor._id, ...paddedRange(earliest, today, tz) } },
      {
        $facet: {
          today: [{ $match: { dateKey: today } }, DASHBOARD_GROUP],
          thisWeek: [{ $match: { dateKey: { $gte: weekStartKey } } }, DASHBOARD_GROUP],
          thisMonth: [{ $match: { dateKey: { $gte: monthStartKey } } }, DASHBOARD_GROUP],
        },
      },
    ]),
    Appointment.find({
      doctorId: doctor._id,
      ...paddedRange(today, today, tz),
      status: { $ne: 'cancelled' },
    })
      .select(APPOINTMENT_LIST_FIELDS)
      .populate('patientId', 'fullName profilePhoto')
      .populate('clinicId', 'name')
      .sort({ startUtc: 1 })
      .limit(50)
      .lean(),
    Appointment.findOne({
      doctorId: doctor._id,
      status: { $in: ACTIVE_STATUSES },
      startUtc: recent,
      endUtc: { $gt: now },
    })
      .select(APPOINTMENT_LIST_FIELDS)
      .populate('patientId', 'fullName profilePhoto')
      .populate('clinicId', 'name')
      .sort({ startUtc: 1 })
      .lean(),
    Appointment.countDocuments({
      doctorId: doctor._id,
      status: 'pending',
      startUtc: recent,
      endUtc: { $gt: now },
    }),
  ]);

  const facet = facets[0] || {};

  res.json({
    success: true,
    data: {
      doctorName: req.user.fullName || '',
      timezone: tz,
      today: pickStats(facet.today),
      thisWeek: pickStats(facet.thisWeek),
      thisMonth: pickStats(facet.thisMonth),
      rating: doctor.rating,
      totalReviews: doctor.totalReviews,
      // Requests still awaiting the doctor's approval, across all days.
      pendingRequests,
      nextAppointment: next ? toDashboardItem(next) : null,
      // The whole day. The app could only show `nextAppointment`, so a doctor
      // with eight appointments saw "Today's Schedule: 1".
      todayAppointments: todayRows.map(toDashboardItem),
    },
  });
});

// @desc    Earnings report
// @route   GET /api/v1/healthcare/doctors/me/earnings
// @access  Private (Provider)
const getEarnings = asyncHandler(async (req, res) => {
  const doctor = await currentDoctor(req, res);
  const tz = safeZone(doctor.timezone);
  await ensureAppointmentTimes(doctor._id);

  let window;
  try {
    window = resolveEarningsWindow({ ...req.query, tz });
  } catch (err) {
    res.status(400);
    throw err;
  }

  const [result] = await Appointment.aggregate(buildEarningsPipeline(doctor._id, window, tz));
  const breakdown = (result && result.current) || [];
  const previous = (result && result.previous && result.previous[0]) || { total: 0, count: 0 };

  res.json({
    success: true,
    data: {
      period: window.period,
      range: { key: window.key, from: window.fromKey, to: window.toKey, label: window.label },
      timezone: tz,
      total: breakdown.reduce((sum, b) => sum + (b.totalAmount || 0), 0),
      count: breakdown.reduce((sum, b) => sum + (b.count || 0), 0),
      byType: summarizeByType(breakdown),
      breakdown,
      // The equivalent COMPLETE window before this one, so the app can show a
      // real trend (and none at all when there is no baseline).
      previousTotal: previous.total,
      previousCount: previous.count,
      previousRange: { from: window.prevFromKey, to: window.prevToKey },
      previousPeriodLabel: window.previousLabel,
    },
  });
});

// @desc    Get my reviews (from the healthcare Review collection)
// @route   GET /api/v1/healthcare/doctors/me/reviews
// @access  Private (Provider)
const getMyReviews = asyncHandler(async (req, res) => {
  const doctor = await currentDoctor(req, res);

  const { rating: ratingFilter } = req.query;
  const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limitNum = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const skip = (pageNum - 1) * limitNum;

  const query = { doctorId: doctor._id };
  if (ratingFilter) query.rating = parseInt(ratingFilter, 10);

  const [reviews, total, distribution] = await Promise.all([
    Review.find(query)
      .populate('patientId', 'fullName profilePhoto')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    Review.countDocuments(query),
    // The rating bars need every star count, not only the filtered page.
    Review.aggregate([
      { $match: { doctorId: doctor._id } },
      { $group: { _id: '$rating', n: { $sum: 1 } } },
    ]),
  ]);

  const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of distribution) {
    const star = Math.round(Number(row._id));
    if (breakdown[star] !== undefined) breakdown[star] += row.n;
  }

  res.json({
    success: true,
    data: {
      reviews,
      averageRating: doctor.rating,
      totalReviews: doctor.totalReviews,
      // What the app's reviews screen reads — it looked for `stats.average`,
      // found nothing, and showed every doctor a 0.0 rating.
      stats: {
        average: doctor.rating || 0,
        total: doctor.totalReviews || 0,
        breakdown,
      },
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
  const doctor = await currentDoctor(req, res);
  const { startDate, endDate, slotDuration } = req.body || {};

  // Unvalidated before: `slotDuration: 1` over a 60-day range is ~170k inserts
  // from a single request. Omitted, the doctor's own setting applies.
  if (slotDuration !== undefined) {
    const check = validateSettings({ slotDuration });
    if (!check.ok) {
      res.status(400);
      throw new Error(check.errors[0].message);
    }
  }

  // Delegates to slotGenerationService — the SAME code the rolling-horizon job
  // runs, so a manual generate and the nightly top-up can never disagree.
  const tz = safeZone(
    doctor.timezone ||
      (await Clinic.findOne({ doctorId: doctor._id, isActive: { $ne: false } }).select('timezone').lean())?.timezone
  );
  const fromKey = isDateKey(startDate) ? startDate : todayKey(tz);
  let toKey = isDateKey(endDate) ? endDate : addDays(fromKey, HORIZON_DAYS, tz);
  // An open-ended range was a way to ask one request for years of slots.
  const maxKey = addDays(fromKey, HORIZON_DAYS + 7, tz);
  if (toKey > maxKey) toKey = maxKey;
  if (toKey < fromKey) {
    res.status(400);
    throw new Error('endDate must not be before startDate');
  }

  let result;
  try {
    result = await generateForDoctor({ doctor, fromKey, toKey, slotDuration });
  } catch (err) {
    if (err instanceof GenerationLimitError) res.status(400);
    throw err;
  }

  res.status(201).json({
    success: true,
    message: `${result.created} slots generated`,
    data: {
      created: result.created,
      candidates: result.candidates,
      skipped: result.skipped,
      publishedThrough: result.through,
    },
  });
});

// ═══════════════════════════════════════════
//  MEDICAL NOTES (doctor's private notes per patient)
// ═══════════════════════════════════════════

// @desc    Get a patient's summary + this doctor's notes for them
// @route   GET /api/v1/healthcare/doctors/me/patients/:patientId/notes
const getPatientNotes = asyncHandler(async (req, res) => {
  const doctor = await currentDoctor(req, res);

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
  const doctor = await currentDoctor(req, res);

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
  const doctor = await currentDoctor(req, res);

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
  const doctor = await currentDoctor(req, res);

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
  const doctor = await currentDoctor(req, res);

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
  const doctor = await currentDoctor(req, res);

  const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const filter = { doctorId: doctor._id, status: 'completed' };

  // Paginated and lean. This loaded every completed appointment the doctor
  // ever had, hydrated with two populates, to render a list of amounts.
  const [appts, total] = await Promise.all([
    Appointment.find(filter)
      .select('patientId patientInfo.name type totalAmount fee completedAt startUtc createdAt')
      .populate('patientId', 'fullName')
      .sort({ completedAt: -1, _id: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean(),
    Appointment.countDocuments(filter),
  ]);

  const transactions = appts.map((a) => ({
    transactionId: a._id,
    patientName: a.patientId?.fullName || a.patientInfo?.name || '',
    appointmentId: a._id,
    type: a.type,
    amount: a.totalAmount || a.fee || 0,
    method: 'cash',
    status: 'completed',
    date: a.completedAt || a.startUtc || a.createdAt,
  }));

  res.json({
    success: true,
    data: {
      transactions,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    },
  });
});

// @desc    Patients this doctor has seen, most recent visit first
// @route   GET /api/v1/healthcare/doctors/me/patients?q=&page=&limit=
// @access  Private (Provider)
const getMyPatients = asyncHandler(async (req, res) => {
  const doctor = await currentDoctor(req, res);

  const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limitNum = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '';
  const pattern = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // The app built this list from the first page of appointments (the server
  // default of 10) while the server loaded the doctor's whole history. One
  // aggregation, grouped by patient, paged in the database.
  const [result] = await Appointment.aggregate([
    { $match: { doctorId: doctor._id, status: { $ne: 'cancelled' } } },
    {
      $project: {
        patientId: 1,
        startUtc: 1,
        createdAt: 1,
        status: 1,
        type: 1,
        'patientInfo.name': 1,
        'patientInfo.phone': 1,
      },
    },
    { $sort: { startUtc: -1, createdAt: -1 } },
    {
      $group: {
        _id: '$patientId',
        lastVisit: { $first: { $ifNull: ['$startUtc', '$createdAt'] } },
        lastAppointmentId: { $first: '$_id' },
        lastStatus: { $first: '$status' },
        lastType: { $first: '$type' },
        appointmentCount: { $sum: 1 },
        name: { $first: '$patientInfo.name' },
        phone: { $first: '$patientInfo.phone' },
      },
    },
    ...(pattern ? [{ $match: { name: { $regex: pattern, $options: 'i' } } }] : []),
    { $sort: { lastVisit: -1 } },
    {
      $facet: {
        rows: [{ $skip: (pageNum - 1) * limitNum }, { $limit: limitNum }],
        total: [{ $count: 'n' }],
      },
    },
  ]);

  const rows = (result && result.rows) || [];
  const total = (result && result.total && result.total[0] && result.total[0].n) || 0;
  const users = rows.length
    ? await User.find({ _id: { $in: rows.map((r) => r._id) } }).select('fullName profilePhoto').lean()
    : [];
  const usersById = new Map(users.map((u) => [String(u._id), u]));

  const patients = rows.map((r) => {
    const user = usersById.get(String(r._id));
    return {
      patientId: r._id,
      name: user?.fullName || r.name || 'Patient',
      profilePhoto: user?.profilePhoto || null,
      phone: r.phone || '',
      lastVisit: r.lastVisit,
      lastAppointmentId: r.lastAppointmentId,
      lastStatus: r.lastStatus,
      lastType: r.lastType,
      appointmentCount: r.appointmentCount,
    };
  });

  res.json({
    success: true,
    data: {
      patients,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    },
  });
});

module.exports = {
  getMyPatients,
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