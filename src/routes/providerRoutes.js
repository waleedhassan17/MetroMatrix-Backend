const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { uploadDocument, uploadMultipleDocuments } = require('../middleware/uploadMiddleware');
const { protect, providerOnly, verifiedProvider, optionalAuth } = require('../middleware/authMiddleware');
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

// Private routes (authenticated providers only)
router.use(protect, providerOnly);

// Profile management
router.route('/profile')
  .get(getProviderProfile)
  .put(updateProviderProfile);

// Personal information submission
router.post('/personal-info', personalInfoRules, validate, submitPersonalInfo);

// Document upload
router.post('/upload-document', uploadDocument, uploadDocumentController);

// Verification status
router.get('/verification', getVerificationStatus);

// Availability management
router.put('/availability', availabilityRules, validate, updateAvailability);

// Public routes (no authentication required)
router.use(optionalAuth);

// Get all providers
router.get('/', getProviders);

// Search providers
router.get('/search', searchProviders);

// Get providers by type
router.get('/by-type/:type', getProvidersByType);

// Get single provider details
router.get('/:id', getProviderById);

// Rate provider (requires authentication)
router.post('/:id/rate', 
  protect,
  ratingRules,
  validate,
  rateProvider
);

module.exports = router;