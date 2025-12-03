const express = require('express');
const router = express.Router();
const passport = require('passport');
const { body } = require('express-validator');
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
  verifyResetOTP,             // ✅ NEW - Verify OTP
  resendResetOTP,             // ✅ NEW - Resend OTP
  verifyEmail,
  logout,
  sendVerificationEmail,
  sendProviderVerificationEmail, // ✅ NEW - Provider standalone verification
  verifyEmailToken,
  verifyUserEmail,            // ✅ NEW - User verification
  verifyProviderEmail,        // ✅ NEW - Provider verification
  checkEmailVerificationStatus,
  resetVerificationLimit,
  manualVerifyEmail,
  getVerificationStatus,
  resendProviderVerification, // ✅ NEW - Resend verification email
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

// ===== PROVIDER EMAIL VERIFICATION (STANDALONE - NO ACCOUNT CREATION) =====
router.post('/provider/send-verification-email', 
  body('email').isEmail().normalizeEmail().withMessage('Invalid email'),
  validate,
  sendProviderVerificationEmail
);

// ===== RESEND PROVIDER VERIFICATION EMAIL =====
router.post('/provider/resend-verification', 
  body('email').isEmail().normalizeEmail().withMessage('Invalid email'),
  validate,
  resendProviderVerification
);

// ===== GOOGLE OAUTH ROUTES =====
router.get('/google', (req, res, next) => {
  const { type = 'user' } = req.query;
  
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    state: type, // Pass type through state parameter
    session: false,
  })(req, res, next);
});

router.get('/google/callback',
  (req, res, next) => {
    passport.authenticate('google', { 
      session: false,
      failureRedirect: `${process.env.CLIENT_URL || 'http://localhost:3000'}/auth/error`,
    })(req, res, next);
  },
  googleAuth
);

// ===== FACEBOOK OAUTH ROUTES =====
router.get('/facebook', (req, res, next) => {
  const { type = 'user' } = req.query;
  
  passport.authenticate('facebook', {
    scope: ['email', 'public_profile'],
    state: type, // Pass type through state parameter
    session: false,
  })(req, res, next);
});

router.get('/facebook/callback',
  (req, res, next) => {
    passport.authenticate('facebook', { 
      session: false,
      failureRedirect: `${process.env.CLIENT_URL || 'http://localhost:3000'}/auth/error`,
    })(req, res, next);
  },
  facebookAuth
);

// Token management
router.post('/refresh', refreshToken);
router.post('/logout', protect, logout);

// Password reset with OTP
// ✅ UPDATED: New OTP-based password reset flow
router.post('/forgot-password', 
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('userType').optional().isIn(['user', 'provider'])
  ],
  validate,
  forgotPassword
);

// ✅ NEW: Verify OTP and get reset token
router.post('/verify-reset-otp',
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('otp').notEmpty().withMessage('OTP is required'),
  ],
  validate,
  verifyResetOTP
);

// ✅ NEW: Resend OTP
router.post('/resend-reset-otp',
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  ],
  validate,
  resendResetOTP
);

// Reset password with reset token (from OTP)
router.post('/reset-password',
  [
    body('resetToken').notEmpty().withMessage('Reset token is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
  ],
  validate,
  resetPassword
);

// ===== USER VERIFICATION FLOW =====
// User signup verification endpoints
router.post('/user/verify-email',
  body('token').notEmpty().withMessage('Verification token is required'),
  validate,
  verifyUserEmail
);
router.post('/user/check-verification-status', checkEmailVerificationStatus);

// ===== PROVIDER VERIFICATION FLOW =====
// Provider signup verification endpoints
router.post('/provider/verify-email',
  body('token').notEmpty().withMessage('Verification token is required'),
  validate,
  verifyProviderEmail
);
router.post('/provider/check-verification-status', checkEmailVerificationStatus);

// ===== LEGACY/SHARED VERIFICATION ENDPOINTS =====
// Generic verification endpoint (for backward compatibility, uses userType param)
router.post('/verify-email-token', verifyEmailToken);
router.post('/send-verification-email', sendVerificationEmail);
router.post('/check-verification-status', checkEmailVerificationStatus);

// ============================================
// 🔧 DEBUGGING ROUTES (Development only)
// ============================================

// Reset rate limiting for verification emails
router.post('/reset-verification-limit', resetVerificationLimit);

// Manually verify email (bypass email flow)
router.post('/manual-verify', manualVerifyEmail);

// Get verification status by email (GET route)
router.get('/verification-status/:email', getVerificationStatus);

// OAuth success/error pages
router.get('/success', (req, res) => {
  res.json({
    success: true,
    message: 'Authentication successful',
  });
});

router.get('/error', (req, res) => {
  res.status(401).json({
    success: false,
    message: 'Authentication failed. Please try again.',
  });
});

module.exports = router;