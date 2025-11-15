const express = require('express');
const router = express.Router();
const passport = require('passport');
const { body, validationResult } = require('express-validator');
const {
  registerUser,
  loginUser,
  registerProvider,
  loginProvider,
  googleAuth,
  facebookAuth,
  refreshToken,
  forgotPassword,
  resetPassword,
  verifyEmail,
  logout
} = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const { validate } = require('../middleware/validate');

// Validation rules
const userRegistrationRules = [
  body('fullName').notEmpty().withMessage('Full name is required'),
  body('phoneNumber').matches(/^[0-9]{10,15}$/).withMessage('Invalid phone number'),
  body('email').isEmail().normalizeEmail().withMessage('Invalid email'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
];

const loginRules = [
  body('email').isEmail().normalizeEmail().withMessage('Invalid email'),
  body('password').notEmpty().withMessage('Password is required')
];

// User authentication routes
router.post('/register', userRegistrationRules, validate, registerUser);
router.post('/login', loginRules, validate, loginUser);

// Provider authentication routes
router.post('/provider/register', userRegistrationRules, validate, registerProvider);
router.post('/provider/login', loginRules, validate, loginProvider);

// OAuth routes
// Google OAuth
router.get('/google', (req, res, next) => {
  const { type = 'user' } = req.query;
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    state: type
  })(req, res, next);
});

router.get('/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/auth/error' }),
  googleAuth
);

// Facebook OAuth
router.get('/facebook', (req, res, next) => {
  const { type = 'user' } = req.query;
  passport.authenticate('facebook', {
    scope: ['email'],
    state: type
  })(req, res, next);
});

router.get('/facebook/callback',
  passport.authenticate('facebook', { session: false, failureRedirect: '/auth/error' }),
  facebookAuth
);

// Token management
router.post('/refresh', refreshToken);
router.post('/logout', protect, logout);

// Password reset
router.post('/forgot-password', 
  body('email').isEmail().normalizeEmail(),
  validate,
  forgotPassword
);

router.post('/reset-password',
  [
    body('token').notEmpty().withMessage('Reset token is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
  ],
  validate,
  resetPassword
);

// Email verification
router.post('/verify-email',
  body('token').notEmpty().withMessage('Verification token is required'),
  validate,
  verifyEmail
);

// OAuth error handler
router.get('/error', (req, res) => {
  res.status(401).json({
    success: false,
    message: 'Authentication failed'
  });
});

module.exports = router;