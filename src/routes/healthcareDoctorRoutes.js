const express = require('express');
const router = express.Router();
const {
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
  getMyPatients,
  getPatientNotes,
  createNote,
  updateNote,
  deleteNote,
  getPatientHistory,
  getTransactions,
} = require('../controllers/healthcareDoctorController');
const { protect, providerOnly } = require('../middleware/authMiddleware');
const { attachDoctor, requireTreatingDoctor } = require('../modules/healthcare/middleware/healthcareAuth');
const slotHorizonC = require('../modules/healthcare/controllers/slotHorizonController');
const availabilityC = require('../modules/healthcare/controllers/doctorAvailabilityController');
const { uploadMultipleDocuments, uploadProfilePhoto } = require('../middleware/uploadMiddleware');

// The signed-in doctor, loaded once per request as `req.doctor` (lean).
// The profile routes load their own populated / hydrated document instead.
const doctorMe = [protect, providerOnly, attachDoctor()];
const removed = availabilityC.removedEndpoint;

// Public
router.post('/doctors/register', registerDoctor);
router.post('/doctors/signin', signinDoctor);

// Protected Provider
router.post('/doctors/verification', protect, providerOnly, uploadMultipleDocuments, submitVerification);

// Profile & image
router.get('/doctors/me', protect, providerOnly, getMyProfile);
router.patch('/doctors/me', protect, providerOnly, updateMyProfile);
router.post('/doctors/me/image', protect, providerOnly, uploadProfilePhoto, uploadProfileImage);

// Clinics
router.get('/doctors/me/clinics', ...doctorMe, getMyClinics);
router.post('/doctors/me/clinics', ...doctorMe, addClinic);
router.patch('/doctors/me/clinics/:clinicId', ...doctorMe, updateClinic);
router.delete('/doctors/me/clinics/:clinicId', ...doctorMe, deleteClinic);

// ── Availability hub: weekly hours ──
router.get('/doctors/me/availability', ...doctorMe, availabilityC.getAvailability);
router.post('/doctors/me/availability/preview', ...doctorMe, availabilityC.previewAvailability);
router.put('/doctors/me/availability', ...doctorMe, availabilityC.applyAvailability);
router.patch('/doctors/me/availability/settings', ...doctorMe, availabilityC.updateSettings);
// The save of app builds that predate the hub.
router.patch('/doctors/me/availability', ...doctorMe, availabilityC.legacySetAvailability);

// How much bookable runway is left — what the doctor's warning banner reads.
// A first-class endpoint rather than something inferred client-side, because
// silence here is exactly what let production reach zero bookable slots.
router.get('/doctors/me/availability/status', ...doctorMe, slotHorizonC.getAvailabilityStatus);

// ── Availability hub: time off ──
router.get('/doctors/me/time-off', ...doctorMe, availabilityC.listTimeOff);
router.post('/doctors/me/time-off/preview', ...doctorMe, availabilityC.previewTimeOff);
router.post('/doctors/me/time-off', ...doctorMe, availabilityC.createTimeOff);
router.patch('/doctors/me/time-off/:timeOffId', ...doctorMe, availabilityC.updateTimeOff);
router.delete('/doctors/me/time-off/:timeOffId', ...doctorMe, availabilityC.deleteTimeOff);

// ── Availability hub: calendar ──
router.get('/doctors/me/slots/day', ...doctorMe, availabilityC.getDay);
router.get('/doctors/me/slots/summary', ...doctorMe, availabilityC.getSummary);
router.post('/doctors/me/slots', ...doctorMe, availabilityC.createSlots);
router.post('/doctors/me/slots/generate', ...doctorMe, generateSlotsFromAvailability);
// Top the rolling horizon back up on demand. Idempotent — safe to press twice.
router.post('/doctors/me/slots/refresh', ...doctorMe, slotHorizonC.refreshMyHorizon);
router.post('/doctors/me/slots/day/block', ...doctorMe, availabilityC.blockDay);
router.post('/doctors/me/slots/day/unblock', ...doctorMe, availabilityC.unblockDay);
router.post(
  '/doctors/me/slots/block',
  ...doctorMe,
  removed('POST /doctors/me/slots/day/block, or PATCH /doctors/me/slots/:slotId { action: "block" }')
);
router.delete(
  '/doctors/me/slots/block/:slotId',
  ...doctorMe,
  removed('PATCH /doctors/me/slots/:slotId { action: "unblock" }')
);
router.patch('/doctors/me/slots/:slotId', ...doctorMe, availabilityC.patchSlot);
router.delete('/doctors/me/slots/:slotId', ...doctorMe, availabilityC.deleteSlot);
router.get('/doctors/me/schedule', ...doctorMe, removed('GET /doctors/me/slots/day?date=YYYY-MM-DD'));

// Appointments
router.get('/doctors/me/appointments', ...doctorMe, getMyAppointments);
router.get('/doctors/me/appointments/:appointmentId', ...doctorMe, getAppointmentDetail);
router.patch('/doctors/me/appointments/:id/confirm', ...doctorMe, confirmAppointment);
router.patch('/doctors/me/appointments/:id/complete', ...doctorMe, completeAppointment);
router.patch('/doctors/me/appointments/:id/cancel', ...doctorMe, cancelAppointment);

// Prescriptions
router.post('/doctors/me/prescriptions', ...doctorMe, createPrescription);
router.patch('/doctors/me/prescriptions/:id', ...doctorMe, updatePrescription);
router.get('/doctors/me/prescriptions', ...doctorMe, getMyPrescriptions);

// Dashboard & earnings
router.get('/doctors/me/dashboard', ...doctorMe, getDashboard);
router.get('/doctors/me/earnings', ...doctorMe, getEarnings);
router.get('/doctors/me/transactions', ...doctorMe, getTransactions);

// Reviews
router.get('/doctors/me/reviews', ...doctorMe, getMyReviews);

// Patients this doctor has seen (paged, searchable)
router.get('/doctors/me/patients', ...doctorMe, getMyPatients);

// Medical notes (doctor's private notes per patient)
router.get('/doctors/me/patients/:patientId/notes', ...doctorMe, requireTreatingDoctor, getPatientNotes);
router.post('/doctors/me/notes', ...doctorMe, requireTreatingDoctor, createNote);
router.patch('/doctors/me/notes/:noteId', ...doctorMe, updateNote);
router.delete('/doctors/me/notes/:noteId', ...doctorMe, deleteNote);

// Patient history (this doctor's visits with a patient)
router.get('/doctors/me/patients/:patientId/history', ...doctorMe, requireTreatingDoctor, getPatientHistory);

module.exports = router;
