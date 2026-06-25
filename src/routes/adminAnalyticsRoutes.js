const express = require('express');
const router = express.Router();
const {
  getStats,
  getAppointmentAnalytics,
  getRevenueAnalytics,
} = require('../controllers/adminAnalyticsController');
const { protect, adminOnly } = require('../middleware/authMiddleware');

router.get('/analytics/stats', protect, adminOnly, getStats);
router.get('/analytics/appointments', protect, adminOnly, getAppointmentAnalytics);
router.get('/analytics/revenue', protect, adminOnly, getRevenueAnalytics);

module.exports = router;