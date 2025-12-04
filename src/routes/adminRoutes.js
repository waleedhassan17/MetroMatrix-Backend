const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { protect } = require('../middleware/authMiddleware');
const { uploadMultipleDocuments } = require('../middleware/uploadMiddleware');
const {
  adminLogin,
  getDashboardStats,
  getPendingProviders,
  getProviderForReview,
  approveProvider,
  rejectProvider,
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
router.post('/auth/refresh-token', (req, res) => {
  res.json({ success: true, message: 'Use /api/auth/refresh-token endpoint' });
});

// ===== PROFILE MANAGEMENT =====
router.get('/profile', getAdminProfile);
router.put('/profile', updateAdminProfile);
router.put('/change-password', changeAdminPassword);

// ===== DASHBOARD & STATISTICS =====
router.get('/dashboard/stats', getDashboardStatsEnhanced);
router.get('/dashboard/quick-stats', getQuickStats);
router.get('/dashboard', getDashboardStats); // Legacy route

// ===== PROVIDER MANAGEMENT =====
// List & Filter
router.get('/providers', getAllProvidersEnhanced);
router.get('/providers/pending', getPendingProvidersEnhanced);

// Provider Details & Actions
router.get('/providers/:providerId', getProviderDetails);
router.put('/providers/:providerId/approve', approveProviderEnhanced);
router.put(
  '/providers/:providerId/reject',
  body('reason').notEmpty().withMessage('Rejection reason is required'),
  validate,
  rejectProviderEnhanced
);
router.put('/providers/:providerId/activate', activateProvider);
router.put('/providers/:providerId/deactivate', deactivateProvider);
router.delete('/providers/:providerId', deleteProvider);

// Legacy routes
router.get('/providers/:id', getProviderForReview);
router.post('/providers/:id/approve', approveProvider);
router.post(
  '/providers/:id/reject',
  body('reason').notEmpty().withMessage('Rejection reason is required'),
  validate,
  rejectProvider
);
router.put('/providers/:id/deactivate', deactivateProvider);
router.put('/providers/:id/activate', activateProvider);

// ===== USER MANAGEMENT =====
router.get('/users', getAllUsersEnhanced);
router.get('/users/:userId', getUserDetails);
router.put('/users/:userId/activate', activateUserEnhanced);
router.put('/users/:userId/deactivate', deactivateUserEnhanced);
router.delete('/users/:userId', deleteUser);

// Legacy routes
router.put('/users/:id/deactivate', deactivateUser);
router.put('/users/:id/activate', activateUser);

// ===== NOTIFICATIONS =====
router.get('/notifications', getNotifications);
router.get('/notifications/unread-count', getUnreadCount);
router.put('/notifications/read-all', markAllAsRead);
router.delete('/notifications/clear-all', clearAllNotifications);
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
router.delete('/posts/:id', deletePost);

// ===== PROVIDER SUBMISSION MANAGEMENT =====
router.get('/provider-submissions', getProviderSubmissions);
router.get('/provider-submissions/:id', getProviderSubmissionById);
router.post('/provider-submissions/:id/approve', approveProviderSubmission);
router.post(
  '/provider-submissions/:id/reject',
  body('rejectionReason').notEmpty().withMessage('Rejection reason is required'),
  validate,
  rejectProviderSubmission
);

module.exports = router;