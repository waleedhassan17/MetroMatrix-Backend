const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { uploadSingleDocument, uploadMultipleDocuments } = require('../middleware/uploadMiddleware');
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
router.use(providerOnly);

// Verification status (specific route before generic :id)
router.get('/verification', getVerificationStatus);

// Profile management
router.get('/profile', getProviderProfile);
router.put('/profile', updateProviderProfile);

// Personal information submission with documents
router.post('/personal-info', uploadMultipleDocuments, personalInfoRules, validate, submitPersonalInfo);

// Document upload - single file
router.post('/upload-document', uploadSingleDocument, uploadDocumentController);

// Availability management
router.put('/availability', availabilityRules, validate, updateAvailability);

module.exports = router;