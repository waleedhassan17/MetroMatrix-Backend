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
} = require('../controllers/adminController');

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

// Public routes
router.post('/login', loginRules, validate, adminLogin);

// ===== PUBLIC PROVIDER SUBMISSION (NO AUTH REQUIRED) =====
router.post('/provider-submissions', uploadMultipleDocuments, submitProviderApplication);
router.get('/provider-submissions/check-status', checkSubmissionStatus);

// Protected admin routes
router.use(protect);
router.use(adminOnly);

// Dashboard
router.get('/dashboard', getDashboardStats);

// Provider management
router.get('/providers/pending', getPendingProviders);
router.get('/providers/:id', getProviderForReview);
router.post('/providers/:id/approve', approveProvider);
router.post(
  '/providers/:id/reject',
  body('reason').notEmpty().withMessage('Rejection reason is required'),
  validate,
  rejectProvider
);
router.get('/providers', getAllProviders);
router.put('/providers/:id/deactivate', deactivateProvider);
router.put('/providers/:id/activate', activateProvider);

// User management
router.get('/users', getAllUsers);
router.put('/users/:id/deactivate', deactivateUser);
router.put('/users/:id/activate', activateUser);

// Post management
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