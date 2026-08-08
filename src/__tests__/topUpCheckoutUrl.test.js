/**
 * Regression guard for a P0 found only by hitting the deployed backend:
 * STRIPE_BACKEND_URL was unset in production, so success_url interpolated to
 * the literal string "undefined/api/wallet/topup/success" and Stripe rejected
 * EVERY top-up at session creation with:
 *
 *   Invalid URL: An explicit scheme (such as https) must be provided.
 *
 * Nothing in the local test suite or the smoke scripts caught it because they
 * all run with STRIPE_BACKEND_URL set in .env. These tests assert the URLs are
 * absolute whether or not the env var exists.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../config/stripe', () => ({
  checkout: { sessions: { create: jest.fn() } },
  customers: { create: jest.fn(), retrieve: jest.fn() },
}));
jest.mock('../services/walletService', () => ({
  // A fresh object per call: the controller assigns stripeCustomerId and saves,
  // so a shared instance would leak that mutation into the next test.
  getOrCreateWallet: jest.fn(async () => ({
    _id: 'w1',
    balance: 0,
    currency: 'PKR',
    stripeCustomerId: null,
    save: jest.fn().mockResolvedValue(undefined),
  })),
  recordTransaction: jest.fn().mockResolvedValue({ _id: 'tx1' }),
}));
jest.mock('../models/WalletTransaction', () => ({
  create: jest.fn().mockResolvedValue({ _id: 'tx1' }),
}));
jest.mock('../models/User', () => ({}));
jest.mock('../models/Provider', () => ({ findOne: jest.fn(), findById: jest.fn() }));

const stripe = require('../config/stripe');
const { createCheckoutSession } = require('../controllers/walletController');

function buildApp() {
  const app = express();
  app.use(express.json());
  // Stand in for `protect`: attach a user the way the real guard does.
  app.post(
    '/api/wallet/topup/checkout',
    (req, _res, next) => {
      req.user = { _id: 'user1' };
      req.isProvider = false;
      next();
    },
    createCheckoutSession
  );
  app.use((err, req, res, _next) => res.status(res.statusCode >= 400 ? res.statusCode : 500).json({ error: err.message }));
  return app;
}

const ABSOLUTE_URL = /^https?:\/\/[^/]+\/api\/wallet\/topup\/(success|cancel)/;

describe('top-up checkout session URLs are always absolute', () => {
  const original = process.env.STRIPE_BACKEND_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    stripe.checkout.sessions.create.mockResolvedValue({
      id: 'cs_test_123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
    });
    stripe.customers.create.mockResolvedValue({ id: 'cus_test_123' });
    stripe.customers.retrieve.mockResolvedValue({ id: 'cus_test_123', deleted: false });
  });

  afterAll(() => {
    if (original === undefined) delete process.env.STRIPE_BACKEND_URL;
    else process.env.STRIPE_BACKEND_URL = original;
  });

  it('uses STRIPE_BACKEND_URL when it is set', async () => {
    process.env.STRIPE_BACKEND_URL = 'https://metro-matrix-backend.vercel.app';
    await request(buildApp()).post('/api/wallet/topup/checkout').send({ amount: 5000 }).expect(200);

    const args = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(args.success_url).toMatch(ABSOLUTE_URL);
    expect(args.success_url).toContain('https://metro-matrix-backend.vercel.app');
    expect(args.cancel_url).toMatch(ABSOLUTE_URL);
  });

  it('falls back to the request origin when STRIPE_BACKEND_URL is MISSING (the production bug)', async () => {
    delete process.env.STRIPE_BACKEND_URL;
    await request(buildApp()).post('/api/wallet/topup/checkout').send({ amount: 5000 }).expect(200);

    const args = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(args.success_url).toMatch(ABSOLUTE_URL);
    expect(args.cancel_url).toMatch(ABSOLUTE_URL);
    // The exact regression: never the literal string "undefined".
    expect(args.success_url).not.toContain('undefined');
    expect(args.cancel_url).not.toContain('undefined');
  });

  it('ties the session to a Stripe Customer and enables saved-card prefill', async () => {
    await request(buildApp()).post('/api/wallet/topup/checkout').send({ amount: 5000 }).expect(200);

    const args = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(args.customer).toBe('cus_test_123');

    // payment_method_save (not payment_intent_data.setup_future_usage) is what
    // saves the card with allow_redisplay 'always'. setup_future_usage saves it
    // as 'limited', which Stripe refuses to prefill — so a swap back to it
    // would silently return us to re-typing the card on every top-up.
    expect(args.saved_payment_method_options).toEqual({
      payment_method_save: 'enabled',
      payment_method_remove: 'enabled',
    });
    expect(args.payment_intent_data?.setup_future_usage).toBeUndefined();
  });

  it('reuses the stored Stripe Customer instead of creating a duplicate', async () => {
    const { getOrCreateWallet } = require('../services/walletService');
    getOrCreateWallet.mockResolvedValueOnce({
      _id: 'w1',
      balance: 0,
      currency: 'PKR',
      stripeCustomerId: 'cus_existing',
      save: jest.fn(),
    });

    await request(buildApp()).post('/api/wallet/topup/checkout').send({ amount: 5000 }).expect(200);

    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create.mock.calls[0][0].customer).toBe('cus_existing');
  });
});
