const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { uploadSingleDocument, uploadMultipleDocuments } = require('../middleware/uploadMiddleware');
const { protect, providerOnly, optionalAuth } = require('../middleware/authMiddleware');
const { allowLimitedOrFullToken, requireFullToken, getProviderStatus } = require('../middleware/onboardingMiddleware');
const { validate } = require('../middleware/validate');
const {
  getProviderProfile,
  updateProviderProfile,
  submitPersonalInfo,
  uploadDocument: uploadDocumentController,
  getVerificationStatus,
  updateAvailability,
  getProviders,
  searchProviders,
  getProviderById,
  rateProvider,
  getProvidersByType,
  updateProviderProfileComplete, // ✅ NEW
  checkApprovalStatus, // ✅ NEW
} = require('../controllers/providerController');

// Provider info validation
const personalInfoRules = [
  body('providerType').isIn(['doctor', 'home_service', 'vendor']).withMessage('Invalid provider type'),
  body('fullName').trim().notEmpty().withMessage('Full name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('phoneNumber').notEmpty().withMessage('Phone number is required'),
  body('city').notEmpty().withMessage('City is required'),
  body('idNumber').notEmpty().withMessage('ID number is required'),
  body('experience').notEmpty().withMessage('Experience is required'),
];

const availabilityRules = [
  body('availability').isObject().withMessage('Availability must be an object'),
];

const ratingRules = [
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5'),
  body('review').optional().isLength({ max: 500 }).withMessage('Review cannot exceed 500 characters'),
];

// ===== PUBLIC ROUTES (no auth required) =====
// ✅ NEW: Check provider approval status (no auth)
router.get('/approval-status', checkApprovalStatus);

// Get all providers
router.get('/', optionalAuth, getProviders);

// Search providers
router.get('/search', optionalAuth, searchProviders);

// Get providers by type
router.get('/by-type/:type', optionalAuth, getProvidersByType);

// Get single provider details (must be after specific routes)
router.get('/:id', optionalAuth, getProviderById);

// ===== PRIVATE ROUTES (auth required) =====
router.use(protect);

// Rate provider (any authenticated user)
router.post('/:id/rate', ratingRules, validate, rateProvider);

// ===== PROVIDER-ONLY ROUTES =====
// Note: providerOnly is applied per-route instead of globally to support two-phase authentication
// where LIMITED tokens need to access some provider endpoints before full approval

// Verification status (LIMITED or FULL token can check)
router.get('/verification', providerOnly, getProviderStatus, getVerificationStatus);

// Profile management (FULL token only)
router.get('/profile', providerOnly, requireFullToken, getProviderProfile);
router.put('/profile', providerOnly, requireFullToken, updateProviderProfile);

// Personal information submission with documents (LIMITED or FULL token)
// Note: allowLimitedOrFullToken includes providerOnly check internally
router.post('/personal-info', allowLimitedOrFullToken, uploadMultipleDocuments, personalInfoRules, validate, submitPersonalInfo);

// Document upload - single file (FULL token only)
router.post('/upload-document', providerOnly, requireFullToken, uploadSingleDocument, uploadDocumentController);

// Availability management (FULL token only)
router.put('/availability', providerOnly, requireFullToken, availabilityRules, validate, updateAvailability);

module.exports = router;