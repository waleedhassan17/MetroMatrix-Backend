const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { protect, requirePermission } = require('../middleware/authMiddleware');
const { uploadMultipleDocuments } = require('../middleware/uploadMiddleware');
const {
  adminLogin,
  getDashboardStats,
  getPendingProviders,
  getAllUsers,
  getAllProviders,
  deactivateUser,
  activateUser,
  deactivateProvider,
  activateProvider,
  deletePost,
  submitProviderApplication,
  checkSubmissionStatus,
  getProviderSubmissions,
  getProviderSubmissionById,
  approveProviderSubmission,
  rejectProviderSubmission,
  // New enhanced endpoints
  adminLogout,
  getAdminProfile,
  updateAdminProfile,
  changeAdminPassword,
  getDashboardStatsEnhanced,
  getQuickStats,
  getAllProvidersEnhanced,
  getPendingProvidersEnhanced,
  getProviderDetails,
  approveProviderEnhanced,
  rejectProviderEnhanced,
  deleteProvider,
  getAllUsersEnhanced,
  getUserDetails,
  activateUserEnhanced,
  deactivateUserEnhanced,
  deleteUser,
  // Frontend compatibility endpoints
  getRecentRegistrations,
  getProvidersByType,
  getProviderDetailsWithRoute,
  getAnalytics,
  refreshAdminToken,
} = require('../controllers/adminController');

const {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  clearAllNotifications,
} = require('../controllers/notificationController');

const {
  getSettings,
  updateGeneralSettings,
  getNotificationSettings,
  updateNotificationSettings,
  updateSecuritySettings,
  updateAppearanceSettings,
} = require('../controllers/settingsController');

// Create admin middleware
const adminOnly = (req, res, next) => {
  if (!req.user || req.user.constructor.modelName !== 'Admin') {
    res.status(403);
    throw new Error('Access denied. Admin only.');
  }
  next();
};

// Login validation
const loginRules = [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
];

// ===== PUBLIC ROUTES =====
router.post('/auth/login', loginRules, validate, adminLogin);
router.post('/login', loginRules, validate, adminLogin); // Legacy route

// ===== PUBLIC PROVIDER SUBMISSION (NO AUTH REQUIRED) =====
router.post('/provider-submissions', uploadMultipleDocuments, submitProviderApplication);
router.get('/provider-submissions/check-status', checkSubmissionStatus);

// ===== PROTECTED ADMIN ROUTES =====
router.use(protect);
router.use(adminOnly);

// ===== AUTHENTICATION =====
router.post('/auth/logout', adminLogout);
router.post('/auth/refresh-token', refreshAdminToken);

// ===== PROFILE MANAGEMENT =====
router.get('/profile', getAdminProfile);
router.put('/profile', updateAdminProfile);
router.put('/change-password', changeAdminPassword);

// ===== DASHBOARD & STATISTICS =====
router.get('/dashboard/stats', getDashboardStatsEnhanced);
router.get('/dashboard/quick-stats', getQuickStats);
router.get('/dashboard/recent-registrations', getRecentRegistrations);
router.get('/dashboard', getDashboardStats); // Legacy route

// ===== ANALYTICS =====
router.get('/analytics', getAnalytics);

// ===== PROVIDER MANAGEMENT =====
// List & Filter
router.get('/providers/pending', getPendingProvidersEnhanced);
router.get('/providers/:providerType(doctor|home_service|vendor)', getProvidersByType);
router.get('/providers', getAllProvidersEnhanced);

// Provider Details & Actions — reads are open to any admin; approval/
// activation decisions require the canApproveProviders permission
// (previously only checked isAdmin, so any admin regardless of their
// stored permissions could approve/reject/activate/deactivate/delete a
// provider — confirmed live during the Prompt 6 access-control sweep).
router.get('/providers/:providerId/details', getProviderDetailsWithRoute);
router.get('/providers/:providerId', getProviderDetails);
router.put('/providers/:providerId/approve', requirePermission('canApproveProviders'), approveProviderEnhanced);
router.put(
  '/providers/:providerId/reject',
  requirePermission('canApproveProviders'),
  body('reason').notEmpty().withMessage('Rejection reason is required'),
  validate,
  rejectProviderEnhanced
);
router.put('/providers/:providerId/activate', requirePermission('canApproveProviders'), activateProvider);
router.put('/providers/:providerId/deactivate', requirePermission('canApproveProviders'), deactivateProvider);
router.delete('/providers/:providerId', requirePermission('canApproveProviders'), deleteProvider);

// HS5: the legacy '/providers/:id' registrations that used to sit here were
// UNREACHABLE — Express matched the '/providers/:providerId' routes above
// first, so getProviderForReview/approveProvider (POST) were dead code with
// different semantics from the Enhanced handlers the admin app actually calls
// (GET /providers/:providerId + PUT .../approve|reject|activate|deactivate).
// One canonical handler per operation now; the dead registrations are gone.

// ===== USER MANAGEMENT ===== (mutations require canManageUsers — see note above)
router.get('/users', getAllUsersEnhanced);
router.get('/users/:userId', getUserDetails);
router.put('/users/:userId/activate', requirePermission('canManageUsers'), activateUserEnhanced);
router.put('/users/:userId/deactivate', requirePermission('canManageUsers'), deactivateUserEnhanced);
router.delete('/users/:userId', requirePermission('canManageUsers'), deleteUser);

// Legacy routes
router.put('/users/:id/deactivate', requirePermission('canManageUsers'), deactivateUser);
router.put('/users/:id/activate', requirePermission('canManageUsers'), activateUser);

// ===== NOTIFICATIONS ===== (reads open to any admin; bulk-clear requires canManageNotifications)
router.get('/notifications', getNotifications);
router.get('/notifications/unread-count', getUnreadCount);
router.put('/notifications/read-all', markAllAsRead);
router.delete('/notifications/clear-all', requirePermission('canManageNotifications'), clearAllNotifications);
router.put('/notifications/:notificationId/read', markAsRead);
router.delete('/notifications/:notificationId', deleteNotification);

// ===== SETTINGS =====
router.get('/settings', getSettings);
router.put('/settings/general', updateGeneralSettings);
router.get('/settings/notifications', getNotificationSettings);
router.put('/settings/notifications', updateNotificationSettings);
router.put('/settings/security', updateSecuritySettings);
router.put('/settings/appearance', updateAppearanceSettings);

// ===== POST MANAGEMENT =====
router.delete('/posts/:id', requirePermission('canManagePosts'), deletePost);

// ===== PROVIDER SUBMISSION MANAGEMENT =====
router.get('/provider-submissions', getProviderSubmissions);
router.get('/provider-submissions/:id', getProviderSubmissionById);
router.post('/provider-submissions/:id/approve', requirePermission('canApproveProviders'), approveProviderSubmission);
router.post(
  '/provider-submissions/:id/reject',
  requirePermission('canApproveProviders'),
  body('rejectionReason').notEmpty().withMessage('Rejection reason is required'),
  validate,
  rejectProviderSubmission
);

module.exports = router;