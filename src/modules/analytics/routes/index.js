/**
 * Analytics service routes — mounted at /api (gateway/registry.js).
 */
const express = require('express');
const router = express.Router();
const { protect, adminOnly, requirePermission } = require('../../../middleware/authMiddleware');
const c = require('../controllers/analyticsController');

// Platform-wide, admins only.
router.get('/admin/platform/realtime', protect, adminOnly, requirePermission('canViewAnalytics'), c.realtime);
router.get('/admin/platform/demand', protect, adminOnly, requirePermission('canViewAnalytics'), c.demand);
router.get('/admin/platform/performance', protect, adminOnly, requirePermission('canViewAnalytics'), c.performance);

// A provider / doctor / vendor's own expected demand.
router.get('/insights/demand/mine', protect, c.myDemand);

module.exports = router;
