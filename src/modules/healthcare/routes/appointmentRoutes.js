const express = require('express');
const router = express.Router();
const {
  // Validation
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
} = require('../controllers/appointmentController');
const { requireUser, requireDoctor, requireAppointmentParticipant } = require('../middleware/healthcareAuth');
const { getAppointmentPrescription } = require('../controllers/prescriptionController');
const { payAppointment, getPaymentState } = require('../controllers/paymentController');

// ─── Patient routes (requireUser) ───────────────────
// Static routes MUST come before :appointmentId param
router.get('/my', requireUser, getAppointments);          // legacy alias
router.get('/doctor', requireUser, requireDoctor, getDoctorAppointments);

router.get('/', requireUser, getAppointments);             // API 1
router.post('/', requireUser, bookingValidationRules, handleValidationErrors, bookAppointment); // Booking

// Payment (H2) — PHI-guarded by participant check
router.post('/:appointmentId/pay', requireUser, requireAppointmentParticipant, payAppointment);
router.get('/:appointmentId/payment', requireUser, requireAppointmentParticipant, getPaymentState);

router.get('/:appointmentId', requireUser, getAppointmentDetail); // API 2
router.get('/:appointmentId/prescription', requireUser, getAppointmentPrescription); // Prescription lookup
router.patch('/:appointmentId/cancel', requireUser, cancelValidationRules, handleValidationErrors, cancelAppointment);     // API 3
router.patch('/:appointmentId/reschedule', requireUser, rescheduleValidationRules, handleValidationErrors, rescheduleAppointment); // API 4

// Legacy PUT routes (kept for backward compat)
router.put('/:id/cancel', requireUser, cancelValidationRules, handleValidationErrors, cancelAppointment);
router.put('/:id/status', requireUser, requireDoctor, updateAppointmentStatus);

module.exports = router;
