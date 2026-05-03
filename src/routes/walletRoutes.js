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
} = require('../controllers/walletController');

// ===== PUBLIC ROUTES =====
// Stripe webhook - MUST use raw body parsing for signature verification
// This route is defined first to ensure raw parsing applies before JSON parsing
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  stripeWebhook
);

// Top-up success/cancel pages (public, for Stripe redirect)
router.get('/topup/success', topUpSuccess);
router.get('/topup/cancel', topUpCancel);

// ===== PROTECTED ROUTES =====
// All remaining routes require authentication
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

module.exports = router;
