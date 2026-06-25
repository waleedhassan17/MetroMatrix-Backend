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
  getMySchedule,
  createSlots,
  blockSlots,
  unblockSlot,
  setAvailability,
  getAvailability,
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
} = require('../controllers/healthcareDoctorController');
const { protect, providerOnly } = require('../middleware/authMiddleware');
const { uploadMultipleDocuments, uploadProfilePhoto } = require('../middleware/uploadMiddleware');

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
router.get('/doctors/me/clinics', protect, providerOnly, getMyClinics);
router.post('/doctors/me/clinics', protect, providerOnly, addClinic);
router.patch('/doctors/me/clinics/:clinicId', protect, providerOnly, updateClinic);
router.delete('/doctors/me/clinics/:clinicId', protect, providerOnly, deleteClinic);

// Schedule & Slots
router.get('/doctors/me/schedule', protect, providerOnly, getMySchedule);
router.post('/doctors/me/slots', protect, providerOnly, createSlots);
router.post('/doctors/me/slots/block', protect, providerOnly, blockSlots);
router.delete('/doctors/me/slots/block/:slotId', protect, providerOnly, unblockSlot);

// Availability
router.patch('/doctors/me/availability', protect, providerOnly, setAvailability);
router.get('/doctors/me/availability', protect, providerOnly, getAvailability);

router.get('/doctors/me/appointments', protect, providerOnly, getMyAppointments);
router.get('/doctors/me/appointments/:appointmentId', protect, providerOnly, getAppointmentDetail);
router.patch('/doctors/me/appointments/:id/confirm', protect, providerOnly, confirmAppointment);
router.patch('/doctors/me/appointments/:id/complete', protect, providerOnly, completeAppointment);
router.patch('/doctors/me/appointments/:id/cancel', protect, providerOnly, cancelAppointment);

// Prescriptions
router.post('/doctors/me/prescriptions', protect, providerOnly, createPrescription);
router.patch('/doctors/me/prescriptions/:id', protect, providerOnly, updatePrescription);
router.get('/doctors/me/prescriptions', protect, providerOnly, getMyPrescriptions);

// Dashboard & earnings
router.get('/doctors/me/dashboard', protect, providerOnly, getDashboard);
router.get('/doctors/me/earnings', protect, providerOnly, getEarnings);

// Reviews
router.get('/doctors/me/reviews', protect, providerOnly, getMyReviews);

module.exports = router;