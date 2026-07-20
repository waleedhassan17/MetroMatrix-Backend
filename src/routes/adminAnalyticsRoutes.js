const express = require('express');
const router = express.Router();
const {
  getStats,
  getAppointmentAnalytics,
  getRevenueAnalytics,
} = require('../controllers/adminAnalyticsController');
const { protect, adminOnly, requirePermission } = require('../middleware/authMiddleware');

router.get('/analytics/stats', protect, adminOnly, requirePermission('canViewAnalytics'), getStats);
router.get('/analytics/appointments', protect, adminOnly, requirePermission('canViewAnalytics'), getAppointmentAnalytics);
router.get('/analytics/revenue', protect, adminOnly, requirePermission('canViewAnalytics'), getRevenueAnalytics);

module.exports = router;