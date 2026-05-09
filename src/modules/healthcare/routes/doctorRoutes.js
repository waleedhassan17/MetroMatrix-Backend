const express = require('express');
const router = express.Router();
const {
  getDoctors,
  searchDoctors,
  getFeaturedDoctors,
  getDoctor,
  registerDoctor,
  updateDoctorProfile,
  getMyProfile,
  addClinic,
  updateClinic,
  setClinicTimings,
  getDoctorClinics,
} = require('../controllers/doctorController');
const { getDoctorSlots } = require('../controllers/slotController');
const { getDoctorReviews } = require('../controllers/reviewController');
const { requireUser, requireDoctor } = require('../middleware/healthcareAuth');

// ─── Public routes ──────────────────────────────────
// IMPORTANT: Static routes MUST come before :doctorId param route
router.get('/search', searchDoctors);
router.get('/featured', getFeaturedDoctors);
router.get('/', getDoctors);

// Nested public routes under :doctorId
router.get('/:doctorId/slots', getDoctorSlots);
router.get('/:doctorId/clinics', getDoctorClinics);
router.get('/:doctorId/reviews', getDoctorReviews);
router.get('/:doctorId', getDoctor);

// ─── Private — authenticated user ───────────────────
router.post('/register', requireUser, registerDoctor);
router.get('/me', requireUser, getMyProfile);

// ─── Private — verified doctor only ─────────────────
router.put('/profile', requireUser, requireDoctor, updateDoctorProfile);
router.post('/clinics', requireUser, requireDoctor, addClinic);
router.put('/clinics/:clinicId', requireUser, requireDoctor, updateClinic);
router.put('/clinics/:clinicId/timings', requireUser, requireDoctor, setClinicTimings);

module.exports = router;
