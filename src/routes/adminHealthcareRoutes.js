const express = require('express');
const router = express.Router();
const { protect, adminOnly, requirePermission } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/adminHealthcareController');

// Healthcare admin oversight (H3) — mounted under /api/v1/admin in app.js,
// same pattern as adminDoctorRoutes/adminAnalyticsRoutes.
router.use(protect, adminOnly);

// Mutations require canManageHealthcare — previously stored on Admin but
// never enforced anywhere in this router (confirmed via grep during the
// Prompt 6 access-control sweep: any admin, regardless of permissions,
// could force an appointment status, refund it, or moderate a review).
const manage = requirePermission('canManageHealthcare');

// Doctor oversight (extends adminDoctorRoutes pending/approve/reject/list)
router.get('/doctors/:doctorId/documents', ctrl.getDoctorDocuments);
router.patch('/doctors/:doctorId/status', manage, ctrl.setDoctorStatus);
router.get('/doctors/:doctorId', ctrl.getDoctorDetail);
router.patch('/doctors/:doctorId', manage, ctrl.updateDoctorProfile);

// Appointment oversight
router.get('/appointments', ctrl.listAppointments);
router.get('/appointments/:id', ctrl.getAppointmentDetail);
router.patch('/appointments/:id/status', manage, ctrl.forceAppointmentStatus);
router.post('/appointments/:id/refund', manage, ctrl.refundAppointment);

// Clinic oversight
router.get('/clinics', ctrl.listClinics);
router.get('/clinics/:id', ctrl.getClinicDetail);
router.patch('/clinics/:id/status', manage, ctrl.setClinicStatus);

// Review moderation
router.get('/healthcare/reviews', ctrl.listReviews);
router.delete('/healthcare/reviews/:id', manage, ctrl.deleteReview);

// Dashboard + settings
router.get('/healthcare/dashboard', ctrl.dashboard);
router.get('/healthcare/settings', ctrl.getSettings);
router.patch('/healthcare/settings', manage, ctrl.patchSettings);

module.exports = router;
