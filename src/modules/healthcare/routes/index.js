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
// Video calls & coupons are out of scope for now (telemedicine/payment excluded).
router.use('/notifications', require('./notificationRoutes'));

module.exports = router;