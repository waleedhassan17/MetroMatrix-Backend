const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { uploadAvatar } = require('../middleware/uploadMiddleware');
const { protect, userOnly } = require('../middleware/authMiddleware');
const { validate } = require('../middleware/validate');
const {
  getUserProfile,
  updateUserProfile,
  completeProfile,
  uploadProfilePhoto,
  updatePreferences,
  deleteAccount,
  getUsers,
  getUserById,
} = require('../controllers/userController');

// Profile validation rules
const profileUpdateRules = [
  body('fullName').optional().isLength({ min: 2 }).withMessage('Name must be at least 2 characters'),
  body('phoneNumber').optional().matches(/^[0-9]{10,15}$/).withMessage('Invalid phone number'),
  body('dateOfBirth').optional().isISO8601().withMessage('Invalid date format'),
  body('gender').optional().isIn(['male', 'female', 'other']).withMessage('Invalid gender'),
];

const profileCompletionRules = [
  body('step').isInt({ min: 1, max: 3 }).withMessage('Invalid step'),
  body('data').isObject().withMessage('Data must be an object'),
];

// User routes
router.use(protect); // All routes below require authentication

// Profile management
router.route('/profile')
  .get(userOnly, getUserProfile)
  .put(userOnly, profileUpdateRules, validate, updateUserProfile);

// Profile completion
router.post('/complete-profile', userOnly, profileCompletionRules, validate, completeProfile);

// Profile photo upload
router.post('/upload-photo', userOnly, uploadAvatar, uploadProfilePhoto);

// Preferences
router.put('/preferences', userOnly, updatePreferences);

// Account deletion
router.delete('/account', userOnly, deleteAccount);

// Admin routes (would need admin middleware in production)
router.get('/', getUsers); // Get all users
router.get('/:id', getUserById); // Get user by ID

module.exports = router;