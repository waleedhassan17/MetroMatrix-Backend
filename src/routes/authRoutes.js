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
  googleLogin,
  googleSignup,
  facebookLogin,
  facebookSignup,
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
const { protect, adminOnly } = require('../middleware/authMiddleware');
const { validate } = require('../middleware/validate');
const googleAuthStatus = require('../config/googleAuthStatus');
const { isFirebaseInitialized } = require('../config/firebase');
const facebookAuthStatus = require('../config/facebookAuthStatus');
const { getPublicBaseUrl } = require('../utils/publicUrl');
const { isSmtpConfigured } = require('../services/emailService');

// ===== LOGGING MIDDLEWARE FOR DEBUGGING =====
// Logs auth requests with timestamp, method, URL and a REDACTED body.
//
// This used to redact only `password`, so Vercel's logs collected Google/
// Firebase ID tokens, Facebook access tokens, reset OTPs and reset tokens in
// plaintext — each one directly replayable to take over an account. Anything
// bearer-shaped is redacted now, and full bodies are only logged outside
// production at all.
const SENSITIVE_BODY_FIELDS = new Set([
  'password',
  'newPassword',
  'currentPassword',
  'confirmPassword',
  'idToken',
  'accessToken',
  'refreshToken',
  'token',
  'resetToken',
  'verificationToken',
  'otp',
  'code',
  'authorization',
]);

const redactBody = (body) => {
  if (!body || typeof body !== 'object') return body;

  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => {
      if (SENSITIVE_BODY_FIELDS.has(key)) return [key, '[REDACTED]'];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return [key, redactBody(value)];
      }
      return [key, value];
    })
  );
};

const isProduction = () => process.env.NODE_ENV === 'production';

router.use((req, res, next) => {
  console.log(`\n📥 ${new Date().toISOString()} - ${req.method} /api/auth${req.path}`);

  // Even redacted, a body can carry PII (emails, names). Keep it to non-prod.
  if (!isProduction()) {
    console.log('📋 Body:', JSON.stringify(redactBody(req.body), null, 2));
  }

  // Track response status
  const originalSend = res.send;
  res.send = function(body) {
    try {
      const parsed = typeof body === 'string' ? JSON.parse(body) : body;
      console.log(`📤 Response [${res.statusCode}]:`, JSON.stringify({
        success: parsed.success,
        message: parsed.message,
        error: parsed.error
      }));
    } catch (e) {
      console.log(`📤 Response [${res.statusCode}]: (non-JSON response)`);
    }
    return originalSend.call(this, body);
  };

  next();
});

/**
 * Gate for the debug/maintenance routes below.
 *
 * `manual-verify` could verify ANY email and flip a provider's canLogin — an
 * unauthenticated auth bypass, reachable on the public deployment. These now
 * require an authenticated admin AND a non-production environment, so they
 * stay usable while developing and are simply absent in production.
 */
const debugRouteOnly = (req, res, next) => {
  if (isProduction()) {
    return res.status(404).json({
      success: false,
      message: 'Not found',
    });
  }
  return next();
};

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
// Without this guard, passport.authenticate('google', ...) throws
// synchronously ("Unknown authentication strategy \"google\"") when
// GOOGLE_CLIENT_ID/SECRET are unset, because config/passport.js never
// registers the strategy in that case — that would 500/crash the request
// instead of failing cleanly. googleAuthStatus.configured mirrors exactly
// whether the strategy was registered (set in config/passport.js).
router.get('/google', (req, res, next) => {
  if (!googleAuthStatus.configured) {
    return res.status(503).json({
      success: false,
      message: 'Google login is not configured on this server.',
      error: 'GOOGLE_AUTH_NOT_CONFIGURED',
    });
  }

  const { type = 'user' } = req.query;

  passport.authenticate('google', {
    scope: ['profile', 'email'],
    state: type, // Pass type through state parameter
    session: false,
  })(req, res, next);
});

router.get('/google/callback',
  (req, res, next) => {
    if (!googleAuthStatus.configured) {
      return res.status(503).json({
        success: false,
        message: 'Google login is not configured on this server.',
        error: 'GOOGLE_AUTH_NOT_CONFIGURED',
      });
    }

    passport.authenticate('google', {
      session: false,
      failureRedirect: `${process.env.CLIENT_URL || 'http://localhost:3000'}/auth/error`,
    })(req, res, next);
  },
  googleAuth
);

// ===== FACEBOOK OAUTH ROUTES =====
// Same guard as Google: without it, passport.authenticate('facebook', ...)
// throws synchronously when FACEBOOK_APP_ID/SECRET are unset, because
// config/passport.js never registers the strategy in that case.
router.get('/facebook', (req, res, next) => {
  if (!facebookAuthStatus.configured) {
    return res.status(503).json({
      success: false,
      message: 'Facebook login is not configured on this server.',
      error: 'FACEBOOK_AUTH_NOT_CONFIGURED',
    });
  }

  const { type = 'user' } = req.query;

  passport.authenticate('facebook', {
    scope: ['email', 'public_profile'],
    state: type, // Pass type through state parameter
    session: false,
  })(req, res, next);
});

router.get('/facebook/callback',
  (req, res, next) => {
    if (!facebookAuthStatus.configured) {
      return res.status(503).json({
        success: false,
        message: 'Facebook login is not configured on this server.',
        error: 'FACEBOOK_AUTH_NOT_CONFIGURED',
      });
    }

    passport.authenticate('facebook', {
      session: false,
      failureRedirect: `${process.env.CLIENT_URL || 'http://localhost:3000'}/auth/error`,
    })(req, res, next);
  },
  facebookAuth
);

// ===== MOBILE SOCIAL LOGIN ENDPOINTS =====
// These endpoints are for mobile apps that handle OAuth client-side
// and send the tokens to the backend for verification

// Google Login (Firebase ID Token verification) - Login or auto-signup
router.post('/google-login',
  [
    body('idToken').notEmpty().withMessage('Google ID token is required'),
    body('userType').optional().isIn(['user', 'provider']).withMessage('userType must be "user" or "provider"'),
  ],
  validate,
  googleLogin
);

// Google Signup (Firebase ID Token verification) - Creates new user only
router.post('/google-signup',
  [
    body('idToken').notEmpty().withMessage('Google ID token is required'),
    body('userType').optional().isIn(['user', 'provider']).withMessage('userType must be "user" or "provider"'),
  ],
  validate,
  googleSignup
);

// Facebook Login (Access Token verification) - Login or auto-signup
router.post('/facebook-login',
  [
    body('accessToken').notEmpty().withMessage('Facebook access token is required'),
    body('userType').optional().isIn(['user', 'provider']).withMessage('userType must be "user" or "provider"'),
  ],
  validate,
  facebookLogin
);

// Facebook Signup (Access Token verification) - Creates new user only
router.post('/facebook-signup',
  [
    body('accessToken').notEmpty().withMessage('Facebook access token is required'),
    body('userType').optional().isIn(['user', 'provider']).withMessage('userType must be "user" or "provider"'),
  ],
  validate,
  facebookSignup
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
// Gated behind: non-production + authenticated admin. Previously public.

// Reset rate limiting for verification emails
router.post('/reset-verification-limit', debugRouteOnly, protect, adminOnly, resetVerificationLimit);

// Manually verify email (bypass email flow) — an auth bypass if left open.
router.post('/manual-verify', debugRouteOnly, protect, adminOnly, manualVerifyEmail);

// Get verification status by email (GET route) — discloses whether an email
// is registered, so it gets the same gate.
router.get('/verification-status/:email', debugRouteOnly, protect, adminOnly, getVerificationStatus);

// ===== AUTH CONFIG HEALTH CHECK =====
// GET /api/auth/health — confirm what's actually wired on THIS deployment
// after setting env vars in Vercel and redeploying, without exposing any
// secret values. This is what to hit before attempting the real browser/
// mobile OAuth flow (see GOOGLE_AUTH_TEST.md).
router.get('/health', (req, res) => {
  const publicBaseUrl = getPublicBaseUrl();

  res.status(200).json({
    success: true,
    nodeEnv: process.env.NODE_ENV || null,
    google: {
      configured: googleAuthStatus.configured,
      callbackURL: googleAuthStatus.callbackURL,
    },
    facebook: {
      configured: facebookAuthStatus.configured,
      callbackURL: facebookAuthStatus.callbackURL,
    },
    firebaseAdminInitialized: isFirebaseInitialized(),

    // Added so a deploy can be checked without shell access: this is where
    // emailed verification/reset links will actually point, and whether
    // real mail can go out at all. No secret values, only presence.
    publicBaseUrl,
    publicBaseUrlLooksStale: /herokuapp\.com/i.test(publicBaseUrl),
    email: {
      smtpConfigured: isSmtpConfigured(),
      host: process.env.EMAIL_HOST || null,
      port: Number(process.env.EMAIL_PORT) || 587,
      from: process.env.EMAIL_FROM || null,
      userConfigured: Boolean(process.env.EMAIL_USER),
      passConfigured: Boolean(process.env.EMAIL_PASS),
    },
  });
});

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