const express = require('express');
const router = express.Router();
const { body, param } = require('express-validator');
const { validate } = require('../middleware/validate');
const {
  protect,
  adminOnly,
  requirePermission,
  requireSuperAdmin,
  selfScoped,
} = require('../middleware/authMiddleware');
const { uploadMultipleDocuments } = require('../middleware/uploadMiddleware');
const auth = require('../controllers/admin/auth');
const {
  getDashboardStats,
  deactivateProvider,
  activateProvider,
  deletePost,
  submitProviderApplication,
  checkSubmissionStatus,
  // New enhanced endpoints
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
  restoreUser,
  restoreProvider,
  // Frontend compatibility endpoints
  getRecentRegistrations,
  getProvidersByType,
  getProviderDetailsWithRoute,
  getAnalytics,
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
  updateNotificationSettings,
  updateSecuritySettings,
  updateFinanceSettings,
} = require('../controllers/settingsController');

// Sign-in validation. No normalizeEmail(): its Gmail rules strip dots, which
// would turn a stored "first.last@gmail.com" into an address that matches no
// admin. The controller lower-cases and trims instead.
const loginRules = [
  body('email').isEmail().withMessage('Enter a valid email address'),
  body('password').isString().notEmpty().withMessage('Enter your password'),
];
const challengeRules = [
  body('challengeToken').isString().notEmpty(),
  body().custom((b) => !!(b && (b.code || b.recoveryCode))).withMessage('Enter the code from your authenticator app or a recovery code'),
];

// ===== PUBLIC ROUTES =====
// Sign-in and token refresh are public by nature (the access token may have
// expired). Brute force is handled per account and per address in the
// controller (MongoDB-backed lockout), not by the in-memory rate limiter.
router.post('/auth/login', loginRules, validate, auth.login);
router.post('/login', loginRules, validate, auth.login); // legacy alias, same chain
router.post('/auth/login/totp', challengeRules, validate, auth.loginTotp);
router.post('/auth/refresh-token', body('refreshToken').isString().notEmpty(), validate, auth.refresh);

// ===== PUBLIC PROVIDER SUBMISSION (NO AUTH REQUIRED) =====
router.post('/provider-submissions', uploadMultipleDocuments, submitProviderApplication);
router.get('/provider-submissions/check-status', checkSubmissionStatus);

// ===== PROTECTED ADMIN ROUTES =====
router.use(protect);
router.use(adminOnly);

// ===== OWN ACCOUNT: sign-out, sessions, password, profile, two-factor =====
router.post('/auth/logout', selfScoped, auth.logout);
router.post('/auth/logout-all', selfScoped, auth.logoutAll);
router.get('/sessions', selfScoped, auth.listSessions);
router.delete('/sessions/:sessionId', selfScoped, param('sessionId').isMongoId(), validate, auth.revokeSession);
router.get('/profile', selfScoped, auth.getProfile);
router.put('/profile', selfScoped, auth.updateProfile);
router.put(
  '/change-password',
  selfScoped,
  body('currentPassword').isString().notEmpty().withMessage('Enter your current password'),
  body('newPassword').isString().notEmpty().withMessage('Enter a new password'),
  validate,
  auth.changePassword
);
router.post('/auth/2fa/enrol', selfScoped, body('currentPassword').isString().notEmpty(), validate, auth.enrolTwoFactor);
router.post('/auth/2fa/verify', selfScoped, body('code').isString().notEmpty(), validate, auth.verifyTwoFactor);
router.post('/auth/2fa/disable', selfScoped, body('currentPassword').isString().notEmpty(), validate, auth.disableTwoFactor);


// ===== DASHBOARD & STATISTICS =====
// Home-screen aggregates every admin sees (replaced by GET /overview in B3,
// which filters by permission).
router.get('/dashboard/stats', getDashboardStatsEnhanced);
router.get('/dashboard/quick-stats', getQuickStats);
router.get('/dashboard/recent-registrations', requirePermission('canApproveProviders'), getRecentRegistrations);
router.get('/dashboard', getDashboardStats); // Legacy route

// ===== ANALYTICS =====
router.get('/analytics', requirePermission('canViewAnalytics'), getAnalytics);

// ===== PROVIDER MANAGEMENT =====
// Provider records carry identity documents, phone numbers and addresses:
// reads and decisions alike need canApproveProviders. Restoring a deleted
// provider is super-admin only.
const providers = requirePermission('canApproveProviders');
router.get('/providers/pending', providers, getPendingProvidersEnhanced);
router.get('/providers/:providerType(doctor|home_service|vendor)', providers, getProvidersByType);
router.get('/providers', providers, getAllProvidersEnhanced);
router.get('/providers/:providerId/details', providers, getProviderDetailsWithRoute);
router.get('/providers/:providerId', providers, getProviderDetails);
router.put('/providers/:providerId/approve', providers, approveProviderEnhanced);
router.put(
  '/providers/:providerId/reject',
  providers,
  body('reason').notEmpty().withMessage('Rejection reason is required'),
  validate,
  rejectProviderEnhanced
);
router.put('/providers/:providerId/activate', providers, activateProvider);
router.put('/providers/:providerId/deactivate', providers, deactivateProvider);
router.delete('/providers/:providerId', providers, deleteProvider);
router.post('/providers/:providerId/restore', requireSuperAdmin, restoreProvider);

// ===== USER MANAGEMENT =====
// Customer accounts are personal data: reads and changes need canManageUsers.
const users = requirePermission('canManageUsers');
router.get('/users', users, getAllUsersEnhanced);
router.get('/users/:userId', users, getUserDetails);
router.put('/users/:userId/activate', users, activateUserEnhanced);
router.put('/users/:userId/deactivate', users, deactivateUserEnhanced);
router.delete('/users/:userId', users, deleteUser);
router.post('/users/:userId/restore', requireSuperAdmin, restoreUser);

// ===== NOTIFICATIONS =====
// Reading and marking read act on the caller's own feed; removing entries from
// the shared feed needs canManageNotifications.
router.get('/notifications', selfScoped, getNotifications);
router.get('/notifications/unread-count', selfScoped, getUnreadCount);
router.put('/notifications/read-all', selfScoped, markAllAsRead);
router.delete('/notifications/clear-all', requirePermission('canManageNotifications'), clearAllNotifications);
router.put('/notifications/:notificationId/read', selfScoped, markAsRead);
router.delete('/notifications/:notificationId', requirePermission('canManageNotifications'), deleteNotification);

// ===== SETTINGS =====
// Reads are open to every admin (the app shows them read-only without the
// permission); writes need canManageSettings; security and finance are
// super-admin only. The appearance section and GET /settings/notifications are
// gone: appearance was stored and read by nothing, and the notifications values
// are in GET /settings.
router.get('/settings', getSettings);
router.put('/settings/general', requirePermission('canManageSettings'), updateGeneralSettings);
router.put('/settings/notifications', requirePermission('canManageSettings'), updateNotificationSettings);
router.put('/settings/security', requireSuperAdmin, updateSecuritySettings);
router.put('/settings/finance', requireSuperAdmin, updateFinanceSettings);

// ===== POST MANAGEMENT =====
router.delete('/posts/:id', requirePermission('canManagePosts'), deletePost);

// The admin /provider-submissions review queue is gone: nothing ever created
// a ProviderSubmission (provider profiles are submitted onto the Provider
// document and reviewed through /providers/* above), so it was always empty —
// and its approve path didn't even set the flag provider login checks.

module.exports = router;