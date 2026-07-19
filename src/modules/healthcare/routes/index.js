const express = require('express');
const router = express.Router();

// Mount all healthcare sub-routes
router.use('/specialties', require('./specialtyRoutes'));
router.use('/doctors', require('./doctorRoutes'));
router.use('/slots', require('./slotRoutes'));
router.use('/appointments', require('./appointmentRoutes'));
router.use('/reviews', require('./reviewRoutes'));
router.use('/prescriptions', require('./prescriptionRoutes'));
router.use('/health-records', require('./healthRecordRoutes'));
// Telemedicine (H6 BUILD decision): Jitsi-in-WebView transport, participant-guarded.
router.use('/video-calls', require('./videoCallRoutes'));
// AI symptom checker (TC-19): LLM tier + deterministic fallback, always disclaimed.
router.use('/symptom-checker', require('./symptomCheckerRoutes'));
// Coupons remain unmounted (payments use the wallet; coupon feature not in scope).
router.use('/notifications', require('./notificationRoutes'));

module.exports = router;