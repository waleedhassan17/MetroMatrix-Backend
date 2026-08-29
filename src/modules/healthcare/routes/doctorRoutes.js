const express = require('express');
const router = express.Router();
const {
  getDoctors,
  searchDoctors,
  getFeaturedDoctors,
  getDoctor,
  updateDoctorProfile,
  addClinic,
  updateClinic,
  setClinicTimings,
  getDoctorClinics,
} = require('../controllers/doctorController');
const {
  getDoctorSlots,
  getAvailabilitySummary,
  getNextAvailable,
} = require('../controllers/slotController');
const { getDoctorReviews } = require('../controllers/reviewController');
const { requireUser, requireDoctor } = require('../middleware/healthcareAuth');

// ─── Public routes ──────────────────────────────────
// IMPORTANT: Static routes MUST come before :doctorId param route
router.get('/search', searchDoctors);
router.get('/featured', getFeaturedDoctors);
router.get('/', getDoctors);

// Nested public routes under :doctorId
router.get('/:doctorId/slots', getDoctorSlots);
// Which upcoming DATES have availability, so the patient's date strip can grey
// out empty days instead of making them tap through blindly, and the earliest
// bookable moment for the "Available from ..." label on a doctor card.
router.get('/:doctorId/availability-summary', getAvailabilitySummary);
router.get('/:doctorId/next-available', getNextAvailable);
router.get('/:doctorId/clinics', getDoctorClinics);
router.get('/:doctorId/reviews', getDoctorReviews);
router.get('/:doctorId', getDoctor);

// NOTE: Doctor self-service auth (register/signin/me) is handled by the
// provider-based healthcareDoctorRoutes. These routes cover clinic & timing
// management for an already-verified doctor (a Provider).

// ─── Private — verified doctor only ─────────────────
router.put('/profile', requireUser, requireDoctor, updateDoctorProfile);
router.post('/clinics', requireUser, requireDoctor, addClinic);
router.put('/clinics/:clinicId', requireUser, requireDoctor, updateClinic);
router.put('/clinics/:clinicId/timings', requireUser, requireDoctor, setClinicTimings);

module.exports = router;
