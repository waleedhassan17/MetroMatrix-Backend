const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { uploadProfilePhoto } = require('../middleware/uploadMiddleware');
const { protect, userOnly } = require('../middleware/authMiddleware');
const { validate } = require('../middleware/validate');
const {
  getUserProfile,
  updateUserProfile,
  completeProfile,
  uploadProfilePhoto: uploadProfilePhotoController,
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

// All user routes require authentication
router.use(protect);

// ===== USER-ONLY ROUTES =====
// Profile management
router.get('/profile', userOnly, getUserProfile);
router.put('/profile', userOnly, profileUpdateRules, validate, updateUserProfile);

// Profile completion
router.post('/complete-profile', userOnly, profileCompletionRules, validate, completeProfile);

// Profile photo upload - FIXED
router.post('/upload-photo', userOnly, uploadProfilePhoto, uploadProfilePhotoController);

// Preferences
router.put('/preferences', userOnly, updatePreferences);

// Account deletion
router.delete('/account', userOnly, deleteAccount);

// ===== ADMIN ROUTES =====
// (In production, add admin middleware)
router.get('/', getUsers);
router.get('/:id', getUserById);

module.exports = router;