const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { protect } = require('../middleware/authMiddleware');
const { validate } = require('../middleware/validate');
const {
  getMyWallet,
  createCheckoutSession,
  topUpSuccess,
  topUpCancel,
  stripeWebhook,
  transferToWallet,
  startConnectOnboarding,
  getConnectStatus,
  connectRefresh,
  connectReturn,
  requestPayout,
} = require('../controllers/walletController');

// ===== PUBLIC ROUTES =====
// Stripe webhook is mounted in src/app.js, BEFORE express.json(), so it can
// receive the raw request body that signature verification requires. Do not
// re-add it here — the global JSON body parser runs before this router and
// would silently break signature verification again (see WALLET_DESIGN.md).

// Top-up success/cancel pages (public, for Stripe redirect)
router.get('/topup/success', topUpSuccess);
router.get('/topup/cancel', topUpCancel);

// Connect onboarding redirect pages (public)
router.get('/connect/refresh', connectRefresh);
router.get('/connect/return', connectReturn);

// ===== PROTECTED ROUTES =====
router.use(protect);

// Get wallet with transaction history
router.get('/me', getMyWallet);

// Create Stripe checkout session for top-up
const checkoutValidationRules = [
  body('amount')
    .isFloat({ min: 1, max: 10000 })
    .withMessage('Amount must be between 1 and 10000'),
];
router.post('/topup/checkout', checkoutValidationRules, validate, createCheckoutSession);

// P2P transfer
const transferValidationRules = [
  body('receiverId').isString().notEmpty().withMessage('receiverId is required'),
  body('receiverType').isIn(['User', 'Provider']).withMessage("receiverType must be 'User' or 'Provider'"),
  body('amount').isFloat({ min: 0.01, max: 100000 }).withMessage('amount must be a positive number'),
  body('description').optional().isString().isLength({ max: 280 }),
  body('idempotencyKey').optional().isString().isLength({ min: 1, max: 128 }),
];
router.post('/transfer', transferValidationRules, validate, transferToWallet);

// Stripe Connect onboarding (providers only)
router.post('/connect/onboard', startConnectOnboarding);
router.get('/connect/status', getConnectStatus);

// Payout to bank (providers only)
const payoutValidationRules = [
  body('amount').isFloat({ min: 1, max: 100000 }).withMessage('amount must be a positive number'),
  body('description').optional().isString().isLength({ max: 280 }),
  body('idempotencyKey').optional().isString().isLength({ min: 1, max: 128 }),
];
router.post('/payout', payoutValidationRules, validate, requestPayout);

module.exports = router;
