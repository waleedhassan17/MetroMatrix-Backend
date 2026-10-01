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
  getPendingProviders,
  getAllUsers,
  getAllProviders,
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

// The legacy `/users/:id/activate` and `/users/:id/deactivate` registrations
// that used to sit here were DEAD CODE: Express matches the first registration
// for a given shape, so `/users/:userId/...` above always won and the legacy
// handlers were never reachable. The comment further up already claimed they
// had been removed — now they actually are. The surviving *Enhanced handlers
// are a strict superset (they accept a `reason` and return the updated state).

// ===== NOTIFICATIONS ===== (reads open to any admin; bulk-clear requires canManageNotifications)
router.get('/notifications', getNotifications);
router.get('/notifications/unread-count', getUnreadCount);
router.put('/notifications/read-all', markAllAsRead);
router.delete('/notifications/clear-all', requirePermission('canManageNotifications'), clearAllNotifications);
router.put('/notifications/:notificationId/read', markAsRead);
router.delete('/notifications/:notificationId', deleteNotification);

// ===== SETTINGS =====
// Reads are open to every admin (the app shows them read-only without the
// permission); writes need canManageSettings, and security is super-admin only.
// The appearance section and GET /settings/notifications are gone: appearance
// was stored and read by nothing, and the notifications values are in GET /settings.
router.get('/settings', getSettings);
router.put('/settings/general', requirePermission('canManageSettings'), updateGeneralSettings);
router.put('/settings/notifications', requirePermission('canManageSettings'), updateNotificationSettings);
router.put('/settings/security', requireSuperAdmin, updateSecuritySettings);

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