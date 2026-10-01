/**
 * Admin management — mounted at /api/admin/admins in src/app.js (before the
 * legacy adminRoutes). See controllers/admin/admins.js for the rules beyond
 * these guards (self-modification, last super admin, super-admin targets).
 */
const express = require('express');
const router = express.Router();
const { param } = require('express-validator');
const { validate } = require('../middleware/validate');
const { protect, adminOnly, requirePermission, requireSuperAdmin } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/admin/admins');

const manage = [protect, adminOnly, requirePermission('canManageAdmins')];
const superOnly = [protect, adminOnly, requireSuperAdmin];
const adminId = [param('adminId').isMongoId(), validate];

router.get('/', manage, ctrl.listAdmins);
router.post('/', superOnly, ctrl.createAdmin);
router.get('/:adminId', manage, adminId, ctrl.getAdmin);
router.patch('/:adminId', manage, adminId, ctrl.updateAdmin);
router.post('/:adminId/reset-password', manage, adminId, ctrl.resetPassword);
router.post('/:adminId/reset-2fa', superOnly, adminId, ctrl.resetTwoFactor);
router.get('/:adminId/sessions', manage, adminId, ctrl.listAdminSessions);
router.delete('/:adminId/sessions/:sessionId', manage, adminId, param('sessionId').isMongoId(), validate, ctrl.revokeAdminSession);

module.exports = router;
