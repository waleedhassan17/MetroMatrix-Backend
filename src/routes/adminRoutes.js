/**
 * /api/admin — the core admin console API (mounted last in app.js; the
 * home-services, wallet and admin-management routers mounted before it own
 * their own paths).
 *
 * Every route answers in the standard envelope (utils/apiResponse.js) and
 * names its guard; src/__tests__/adminRouteGuards.test.js enforces that.
 * Contract: docs/admin.openapi.yaml.
 */
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
const providers = require('../controllers/admin/providers');
const users = require('../controllers/admin/users');
const notifications = require('../controllers/admin/notifications');
const { getAnalytics } = require('../controllers/admin/analytics');
const { deletePost } = require('../controllers/admin/posts');
const { getMeta } = require('../controllers/admin/meta');
const { getOverview, getQueue } = require('../controllers/admin/overview');
const { submitProviderApplication, checkSubmissionStatus } = require('../controllers/providerSubmissionController');
const {
  getSettings,
  updateGeneralSettings,
  updateNotificationSettings,
  updateSecuritySettings,
  updateFinanceSettings,
} = require('../controllers/settingsController');

const reasonRequired = (what) => body('reason').isString().trim().notEmpty().withMessage(`A reason is required to ${what}`);

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

// ===== PROVIDER-APP ONBOARDING (no auth; not part of the admin console) =====
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

// ===== CONSOLE HOME =====
// Every admin may open these; their content is filtered by the caller's
// permissions inside (queues, verticals, activity).
router.get('/meta', getMeta);
router.get('/overview', getOverview);
router.get('/queue', getQueue);

// ===== ANALYTICS =====
router.get('/analytics', requirePermission('canViewAnalytics'), getAnalytics);

// ===== PROVIDERS =====
// Provider records carry identity documents, phone numbers and addresses:
// reads and decisions alike need canApproveProviders. Restore is super-admin only.
const canApprove = requirePermission('canApproveProviders');
const providerId = [param('providerId').isMongoId().withMessage('Unknown provider'), validate];
router.get('/providers', canApprove, providers.listProviders);
router.get('/providers/:providerId', canApprove, providerId, providers.getProvider);
router.get('/providers/:providerId/analytics', canApprove, providerId, providers.getProviderAnalytics);
router.put('/providers/:providerId/approve', canApprove, providerId, providers.approveProvider);
router.put('/providers/:providerId/reject', canApprove, providerId, reasonRequired('reject an application'), validate, providers.rejectProvider);
router.put('/providers/:providerId/suspend', canApprove, providerId, reasonRequired('suspend a provider'), validate, providers.suspendProvider);
router.put('/providers/:providerId/unsuspend', canApprove, providerId, providers.unsuspendProvider);
router.delete('/providers/:providerId', canApprove, providerId, providers.deleteProvider);
router.post('/providers/:providerId/restore', requireSuperAdmin, providerId, providers.restoreProvider);

// ===== USERS =====
// Customer accounts are personal data: reads and changes need canManageUsers.
const canManageUsers = requirePermission('canManageUsers');
const userId = [param('userId').isMongoId().withMessage('Unknown user'), validate];
router.get('/users', canManageUsers, users.listUsers);
router.get('/users/:userId', canManageUsers, userId, users.getUser);
router.put('/users/:userId/activate', canManageUsers, userId, users.activateUser);
router.put('/users/:userId/deactivate', canManageUsers, userId, reasonRequired('deactivate an account'), validate, users.deactivateUser);
router.delete('/users/:userId', canManageUsers, userId, users.deleteUser);
router.post('/users/:userId/restore', requireSuperAdmin, userId, users.restoreUser);

// ===== NOTIFICATIONS =====
// The feed is per admin (read/dismiss acts on the caller's own state);
// permanently purging old notifications for everyone needs canManageNotifications.
const notificationId = [param('notificationId').isMongoId(), validate];
router.get('/notifications', selfScoped, notifications.listNotifications);
router.get('/notifications/unread-count', selfScoped, notifications.unreadCount);
router.put('/notifications/read-all', selfScoped, notifications.markAllRead);
router.delete('/notifications/clear-all', selfScoped, notifications.dismissAllRead);
router.delete('/notifications/purge', requirePermission('canManageNotifications'), notifications.purgeOld);
router.put('/notifications/:notificationId/read', selfScoped, notificationId, notifications.markRead);
router.delete('/notifications/:notificationId', selfScoped, notificationId, notifications.dismiss);

// ===== SETTINGS =====
// Reads are open to every admin (the app shows them read-only without the
// permission); writes need canManageSettings; security and finance are
// super-admin only.
router.get('/settings', getSettings);
router.put('/settings/general', requirePermission('canManageSettings'), updateGeneralSettings);
router.put('/settings/notifications', requirePermission('canManageSettings'), updateNotificationSettings);
router.put('/settings/security', requireSuperAdmin, updateSecuritySettings);
router.put('/settings/finance', requireSuperAdmin, updateFinanceSettings);

// ===== POSTS =====
router.delete('/posts/:id', requirePermission('canManagePosts'), param('id').isMongoId(), validate, deletePost);

module.exports = router;
