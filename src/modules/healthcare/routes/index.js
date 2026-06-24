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
router.use('/video-calls', require('./videoCallRoutes'));
router.use('/coupons', require('./couponRoutes'));
router.use('/notifications', require('./notificationRoutes'));

module.exports = router;