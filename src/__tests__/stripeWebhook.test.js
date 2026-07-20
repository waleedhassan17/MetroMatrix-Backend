/**
 * PART A.5 — proves the raw-body mounting fix actually works: a correctly
 * signed webhook payload verifies and credits the wallet; a bad signature
 * is rejected with 400. Builds a minimal Express app that mounts the route
 * in the EXACT order app.js does (raw body BEFORE express.json()) so a
 * regression to the old (broken) order would fail this test.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../config/stripe', () => ({
  webhooks: { constructEvent: jest.fn() },
}));
jest.mock('../services/walletService', () => ({
  applyTopUp: jest.fn().mockResolvedValue({ wallet: { balance: 5000 }, transaction: { _id: 'tx1' } }),
}));
jest.mock('../models/WalletTransaction', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../models/StripeWebhookEvent', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/User', () => ({}));
jest.mock('../models/Provider', () => ({ findOne: jest.fn() }));

const stripe = require('../config/stripe');
const WalletService = require('../services/walletService');
const StripeWebhookEvent = require('../models/StripeWebhookEvent');
const { stripeWebhook } = require('../controllers/walletController');

function buildApp() {
  const app = express();
  // Same order as src/app.js: raw body for the webhook, mounted BEFORE the
  // global express.json(). This is the property under test.
  app.post('/api/wallet/webhook', express.raw({ type: 'application/json' }), stripeWebhook);
  app.use(express.json());
  // asyncHandler rethrows into next(err); surface it as JSON like errorMiddleware would.
  app.use((err, req, res, next) => {
    res.status(500).json({ success: false, error: err.message });
  });
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('Stripe webhook — raw body reaches signature verification', () => {
  it('a correctly signed checkout.session.completed verifies and credits the wallet (200)', async () => {
    const app = buildApp();
    const payload = JSON.stringify({
      id: 'evt_test_1',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_1', metadata: { ownerId: 'u1', ownerType: 'User' }, amount_total: 500000 } },
    });

    stripe.webhooks.constructEvent.mockImplementation((body) => {
      // The critical assertion: constructEvent must receive a raw Buffer,
      // not a parsed object — proves express.json() did NOT run first.
      expect(Buffer.isBuffer(body)).toBe(true);
      return JSON.parse(body.toString());
    });

    const res = await request(app)
      .post('/api/wallet/webhook')
      .set('stripe-signature', 'valid-test-sig')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(stripe.webhooks.constructEvent).toHaveBeenCalled();
    expect(WalletService.applyTopUp).toHaveBeenCalled();
    expect(StripeWebhookEvent.create).toHaveBeenCalledWith({
      eventId: 'evt_test_1',
      type: 'checkout.session.completed',
    });
  });

  it('a bad signature is rejected with 400 and no wallet mutation happens', async () => {
    const app = buildApp();
    stripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload');
    });

    const res = await request(app)
      .post('/api/wallet/webhook')
      .set('stripe-signature', 'bad-sig')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ id: 'evt_bad', type: 'checkout.session.completed' }));

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(WalletService.applyTopUp).not.toHaveBeenCalled();
    expect(StripeWebhookEvent.create).not.toHaveBeenCalled();
  });

  it('replaying an already-processed event id is a no-op 200, not a double credit', async () => {
    const app = buildApp();
    stripe.webhooks.constructEvent.mockImplementation((body) => JSON.parse(body.toString()));
    const dupErr = new Error('duplicate');
    dupErr.code = 11000;
    StripeWebhookEvent.create.mockRejectedValueOnce(dupErr);

    const payload = JSON.stringify({
      id: 'evt_dup_1',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_dup', metadata: { ownerId: 'u1', ownerType: 'User' }, amount_total: 100000 } },
    });

    const res = await request(app)
      .post('/api/wallet/webhook')
      .set('stripe-signature', 'valid-test-sig')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.alreadyProcessed).toBe(true);
    expect(WalletService.applyTopUp).not.toHaveBeenCalled();
  });

  it('regression guard: a non-Buffer body (express.json() ran first) fails loudly, not silently', async () => {
    // Content-Type deliberately does NOT match 'application/json', so
    // express.raw({ type: 'application/json' }) does not capture the body
    // and req.body falls through as {} — exactly what happens if the
    // raw-body mount is ever removed or reordered after express.json().
    const app = buildApp();
    const res = await request(app)
      .post('/api/wallet/webhook')
      .type('text/plain')
      .send('{"id":"evt_x"}');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/non-Buffer body/i);
    expect(stripe.webhooks.constructEvent).not.toHaveBeenCalled();
  });
});
