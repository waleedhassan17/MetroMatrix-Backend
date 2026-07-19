const mongoose = require('mongoose');
const { body, validationResult } = require('express-validator');
const Appointment = require('../models/Appointment');
const Doctor = require('../models/Doctor');
const Slot = require('../models/Slot');
const paymentService = require('../services/paymentService');
const appointmentService = require('../services/appointmentService');
const slotService = require('../services/slotService');
const couponService = require('../services/couponService');
const notificationService = require('../services/notificationService');

// ═══════════════════════════════════════════════════════
//  VALIDATION RULES
// ═══════════════════════════════════════════════════════

const bookingValidationRules = [
  body('slotId')
    .notEmpty().withMessage('slotId is required')
    .isMongoId().withMessage('slotId must be a valid ID'),
  body('doctorId')
    .notEmpty().withMessage('doctorId is required')
    .isMongoId().withMessage('doctorId must be a valid ID'),
  body('type')
    .notEmpty().withMessage('type is required')
    .isIn(['in-clinic', 'video']).withMessage('type must be in-clinic or video'),
  body('patientInfo.name')
    .notEmpty().withMessage('Patient name is required')
    .isLength({ min: 2, max: 100 }).withMessage('Patient name must be 2-100 characters'),
  body('patientInfo.phone')
    .notEmpty().withMessage('Patient phone is required'),
  body('patientInfo.age')
    .optional()
    .isInt({ min: 0, max: 150 }).withMessage('Age must be between 0 and 150'),
  body('patientInfo.gender')
    .optional()
    .isIn(['male', 'female', 'other', '']).withMessage('Invalid gender value'),
  body('patientInfo.relationship')
    .optional()
    .isString(),
  body('clinicId')
    .optional()
    .isMongoId().withMessage('clinicId must be a valid ID'),
  body('symptoms')
    .optional()
    .isString(),
  body('couponCode')
    .optional()
    .isString().trim(),
];

const cancelValidationRules = [
  body('reason')
    .notEmpty().withMessage('Cancellation reason is required')
    .isLength({ min: 3, max: 500 }).withMessage('Reason must be 3-500 characters'),
];

const rescheduleValidationRules = [
  body('newSlotId')
    .notEmpty().withMessage('newSlotId is required')
    .isMongoId().withMessage('newSlotId must be a valid ID'),
];

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors.array().map((e) => ({
        field: e.path,
        message: e.msg,
      })),
    });
  }
  next();
};

// ═══════════════════════════════════════════════════════
//  API 1: GET /appointments — Patient's appointment list
// ═══════════════════════════════════════════════════════

// @desc    Get patient's appointments with status filtering
// @route   GET /api/v1/healthcare/appointments
// @access  Private
const getAppointments = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;

    // Validate status if provided
    if (status && !['upcoming', 'past', 'cancelled'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Status must be one of: upcoming, past, cancelled',
      });
    }

    const result = await appointmentService.getPatientAppointments(
      req.user._id,
      { status },
      { page: Number(page), limit: Number(limit) }
    );

    res.json({
      success: true,
      count: result.appointments.length,
      data: result.appointments,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
};

// ═══════════════════════════════════════════════════════
//  API 2: GET /appointments/:appointmentId — Detail
// ═══════════════════════════════════════════════════════

// @desc    Get single appointment detail with prescription
// @route   GET /api/v1/healthcare/appointments/:appointmentId
// @access  Private
const getAppointmentDetail = async (req, res, next) => {
  try {
    const result = await appointmentService.getAppointmentDetail(
      req.params.appointmentId,
      req.user._id
    );

    if (!result) {
      return res.status(404).json({ success: false, error: 'Appointment not found' });
    }

    if (result.forbidden) {
      return res.status(403).json({ success: false, error: 'Access denied. This appointment does not belong to you.' });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({ success: false, error: 'Invalid appointment ID' });
    }
    next(error);
  }
};

// ═══════════════════════════════════════════════════════
//  API 3: PATCH /appointments/:appointmentId/cancel
// ═══════════════════════════════════════════════════════

// @desc    Cancel an appointment (transactional)
// @route   PATCH /api/v1/healthcare/appointments/:appointmentId/cancel
// @access  Private
const cancelAppointment = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { reason } = req.body;

    const result = await appointmentService.cancelAppointment(
      req.params.appointmentId,
      req.user._id,
      reason,
      session
    );

    if (result.error) {
      await session.abortTransaction();
      session.endSession();
      return res.status(result.status).json({ success: false, error: result.error });
    }

    await session.commitTransaction();

    // H2: refund per policy (full ≥ window, partial inside; outside txn, best effort).
    let refunded = 0;
    try {
      const fresh = await Appointment.findById(result.appointment._id).populate(
        'slotId',
        'date startTime'
      );
      refunded = await paymentService.refundAppointment(fresh, {
        cancelledBy: 'patient',
        reason: `Refund: appointment cancelled by patient (${reason || 'no reason'})`,
      });
    } catch (refundErr) {
      console.error('Refund failed:', refundErr.message);
    }

    // Send notification to doctor (outside transaction — best effort)
    try {
      const doctor = await Doctor.findById(result.appointment.doctorId);
      if (doctor) {
        await notificationService.createNotification({
          userId: doctor.providerId,
          title: 'Appointment Cancelled',
          message: `An appointment has been cancelled. Reason: ${reason}`,
          type: 'appointment_cancelled',
          data: {
            appointmentId: result.appointment._id,
            reason,
          },
        });
      }
    } catch (notifErr) {
      console.error('Failed to send cancellation notification:', notifErr.message);
    }

    res.json({
      success: true,
      message:
        refunded > 0
          ? `Appointment cancelled. PKR ${refunded} refunded to your wallet.`
          : 'Appointment cancelled successfully',
      data: result.appointment,
      refunded,
    });
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════
//  API 4: PATCH /appointments/:appointmentId/reschedule
// ═══════════════════════════════════════════════════════

// @desc    Reschedule an appointment to a new slot (transactional)
// @route   PATCH /api/v1/healthcare/appointments/:appointmentId/reschedule
// @access  Private
const rescheduleAppointment = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { newSlotId } = req.body;

    const result = await appointmentService.rescheduleAppointment(
      req.params.appointmentId,
      req.user._id,
      newSlotId,
      session
    );

    if (result.error) {
      await session.abortTransaction();
      session.endSession();
      return res.status(result.status).json({ success: false, error: result.error });
    }

    await session.commitTransaction();

    // Send notification to doctor (outside transaction — best effort)
    try {
      const doctor = await Doctor.findById(result.appointment.doctorId);
      if (doctor) {
        await notificationService.createNotification({
          userId: doctor.providerId,
          title: 'Appointment Rescheduled',
          message: `An appointment has been rescheduled to a new time slot.`,
          type: 'appointment_booked', // reuse type, as it's a re-booking
          data: {
            appointmentId: result.appointment._id,
            newSlotId: result.newSlot._id,
            newDate: result.newSlot.date,
            newStartTime: result.newSlot.startTime,
          },
        });
      }
    } catch (notifErr) {
      console.error('Failed to send reschedule notification:', notifErr.message);
    }

    // Return updated appointment with populations
    const populated = await appointmentService.findAppointmentById(result.appointment._id);

    res.json({
      success: true,
      message: 'Appointment rescheduled successfully',
      data: populated,
    });
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════
//  BOOKING (from previous task — kept intact)
// ═══════════════════════════════════════════════════════

// @desc    Book an appointment (transactional)
// @route   POST /api/v1/healthcare/appointments
// @access  Private
const bookAppointment = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      slotId,
      doctorId,
      clinicId,
      type,
      patientInfo,
      symptoms,
      couponCode,
    } = req.body;

    // 1. Validate doctor
    const doctor = await Doctor.findOne({
      _id: doctorId,
      verificationStatus: 'verified',
      isActive: true,
    }).session(session);

    if (!doctor) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ success: false, error: 'Doctor not found or not verified' });
    }

    // 2. Validate slot
    const slot = await slotService.validateSlotForBooking(slotId, doctorId, session);
    if (!slot) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        error: 'Slot is not available or does not belong to this doctor',
      });
    }

    // 3. Fee
    const fee = type === 'video'
      ? (doctor.videoConsultationFee || doctor.consultationFee || 0)
      : (doctor.consultationFee || 0);

    // 4. Coupon
    let discount = 0;
    let couponId = null;
    if (couponCode) {
      const couponResult = await couponService.validateCoupon(couponCode, fee);
      if (couponResult.valid) {
        discount = couponResult.discountAmount;
        couponId = couponResult.coupon.id;
      }
    }

    const totalAmount = Math.max(0, Math.round((fee - discount) * 100) / 100);

    // 5. Create appointment
    const [appointment] = await Appointment.create(
      [
        {
          patientId: req.user._id,
          doctorId: doctor._id,
          slotId: slot._id,
          clinicId: clinicId || null,
          type,
          status: 'pending',
          patientInfo: {
            name: patientInfo.name,
            phone: patientInfo.phone,
            age: patientInfo.age || null,
            gender: patientInfo.gender || '',
            relationship: patientInfo.relationship || 'self',
          },
          symptoms: symptoms || '',
          fee,
          discount,
          totalAmount,
          // BOOKING POLICY (documented choice): appointments can be booked
          // unpaid and settled later — wallet in-app any time before the
          // visit, or cash at the clinic captured when the doctor completes
          // the appointment. Payment is therefore NOT required to confirm.
          payment: { status: 'unpaid', method: null, amount: totalAmount },
        },
      ],
      { session }
    );

    // 6. Increment slot
    await slotService.incrementBookedCount(slot._id, session);

    // 7. Increment coupon usage
    if (couponId) {
      await couponService.incrementUsage(couponId, session);
    }

    // 8. Commit
    await session.commitTransaction();

    // 9. Notification (best effort)
    try {
      await notificationService.notifyAppointmentBooked(
        req.user._id,
        doctor.providerId,
        {
          appointmentId: appointment._id,
          patientName: patientInfo.name,
          type,
          date: slot.date,
          startTime: slot.startTime,
        }
      );
      // TC-17: the PATIENT also gets a booking confirmation notification
      await notificationService.createNotification({
        userId: req.user._id,
        title: 'Appointment Booked',
        message: 'Your appointment request has been received. You will be notified when the doctor confirms.',
        type: 'appointment_booked',
        data: { appointmentId: appointment._id },
      });
    } catch (notifErr) {
      console.error('Failed to send booking notification:', notifErr.message);
    }

    // 10. Return populated
    const populated = await appointmentService.findAppointmentById(appointment._id);

    res.status(201).json({
      success: true,
      message: 'Appointment booked successfully',
      data: populated,
    });
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════
//  DOCTOR ENDPOINTS (from previous task — kept intact)
// ═══════════════════════════════════════════════════════

// @desc    Get doctor's appointments
// @route   GET /api/v1/healthcare/appointments/doctor
// @access  Private/Doctor
const getDoctorAppointments = async (req, res, next) => {
  try {
    const { status, date, page = 1, limit = 10 } = req.query;

    const result = await appointmentService.getDoctorAppointments(
      req.doctor._id,
      { status, date },
      { page: Number(page), limit: Number(limit) }
    );

    res.json({
      success: true,
      count: result.appointments.length,
      data: result.appointments,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update appointment status (confirm/complete)
// @route   PUT /api/v1/healthcare/appointments/:id/status
// @access  Private/Doctor
const updateAppointmentStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    const validStatuses = ['confirmed', 'completed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Status must be one of: ${validStatuses.join(', ')}`,
      });
    }

    const appointment = await Appointment.findOneAndUpdate(
      { _id: req.params.id, doctorId: req.doctor._id },
      { status },
      { new: true, runValidators: true }
    );

    if (!appointment) {
      return res.status(404).json({ success: false, error: 'Appointment not found' });
    }

    if (status === 'confirmed') {
      try {
        await notificationService.notifyAppointmentConfirmed(
          appointment.patientId,
          { appointmentId: appointment._id }
        );
      } catch (err) {
        console.error('Failed to send confirmation notification:', err.message);
      }
    }

    res.json({ success: true, data: appointment });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  // Validation middleware
  bookingValidationRules,
  cancelValidationRules,
  rescheduleValidationRules,
  handleValidationErrors,
  // Patient APIs
  getAppointments,
  getAppointmentDetail,
  cancelAppointment,
  rescheduleAppointment,
  // Booking
  bookAppointment,
  // Doctor APIs
  getDoctorAppointments,
  updateAppointmentStatus,
};
