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

module.exports = router;