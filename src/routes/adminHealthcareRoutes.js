const express = require('express');
const router = express.Router();
const { protect, adminOnly, requirePermission } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/adminHealthcareController');

// Healthcare admin oversight (H3) — mounted under /api/v1/admin in app.js,
// same pattern as adminDoctorRoutes/adminAnalyticsRoutes.
//
// Every route — reads included — needs canManageHealthcare: appointments,
// doctor documents and reviews are patient/health data, which an admin
// without the healthcare permission has no reason to see. Refunds move money
// and also need canManageFinance.
router.use(protect, adminOnly, requirePermission('canManageHealthcare'));

const money = requirePermission('canManageFinance');

// Doctor oversight (extends adminDoctorRoutes pending/approve/reject/list)
router.get('/doctors/:doctorId/documents', ctrl.getDoctorDocuments);
router.patch('/doctors/:doctorId/status', ctrl.setDoctorStatus);
router.get('/doctors/:doctorId', ctrl.getDoctorDetail);
router.patch('/doctors/:doctorId', ctrl.updateDoctorProfile);

// Appointment oversight
router.get('/appointments', ctrl.listAppointments);
router.get('/appointments/:id', ctrl.getAppointmentDetail);
router.patch('/appointments/:id/status', ctrl.forceAppointmentStatus);
router.post('/appointments/:id/refund', money, ctrl.refundAppointment);

// Clinic oversight
router.get('/clinics', ctrl.listClinics);
router.get('/clinics/:id', ctrl.getClinicDetail);
router.patch('/clinics/:id/status', ctrl.setClinicStatus);

// Review moderation
router.get('/healthcare/reviews', ctrl.listReviews);
router.delete('/healthcare/reviews/:id', ctrl.deleteReview);

// Dashboard + settings
router.get('/healthcare/dashboard', ctrl.dashboard);
router.get('/healthcare/settings', ctrl.getSettings);
router.patch('/healthcare/settings', ctrl.patchSettings);

module.exports = router;
