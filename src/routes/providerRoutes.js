const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { uploadSingleDocument } = require('../middleware/uploadMiddleware');
const { protect, providerOnly, optionalAuth } = require('../middleware/authMiddleware');
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
} = require('../controllers/providerController');

// Provider info validation
const personalInfoRules = [
  body('providerType').isIn(['doctor', 'home_service', 'vendor']).withMessage('Invalid provider type'),
  body('experience').notEmpty().withMessage('Experience is required'),
  body('city').notEmpty().withMessage('City is required'),
];

const availabilityRules = [
  body('availability').isObject().withMessage('Availability must be an object'),
];

const ratingRules = [
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5'),
  body('review').optional().isLength({ max: 500 }).withMessage('Review cannot exceed 500 characters'),
];

// ===== PUBLIC ROUTES (no auth required) =====
// Get all providers
router.get('/', optionalAuth, getProviders);

// Search providers
router.get('/search', optionalAuth, searchProviders);

// Get providers by type
router.get('/by-type/:type', optionalAuth, getProvidersByType);

// Get single provider details
router.get('/:id', optionalAuth, getProviderById);

// ===== PRIVATE ROUTES (auth required) =====
router.use(protect);

// Rate provider (any authenticated user)
router.post('/:id/rate', ratingRules, validate, rateProvider);

// ===== PROVIDER-ONLY ROUTES =====
router.use(providerOnly);

// Profile management
router.route('/profile')
  .get(getProviderProfile)
  .put(updateProviderProfile);

// Personal information submission
router.post('/personal-info', personalInfoRules, validate, submitPersonalInfo);

// Document upload - FIXED
router.post('/upload-document', uploadSingleDocument, uploadDocumentController);

// Verification status
router.get('/verification', getVerificationStatus);

// Availability management
router.put('/availability', availabilityRules, validate, updateAvailability);

module.exports = router;