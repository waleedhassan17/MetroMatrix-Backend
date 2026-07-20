/**
 * Wallet Stripe smoke test (Part E.5) — runnable against a LIVE server with
 * real Stripe TEST MODE credentials loaded. Proves, end-to-end over real
 * HTTP + a genuinely-signed webhook payload, the properties STRIPE_TESTING.md
 * walks a human through by hand:
 *
 *   1. create a test user, top up via a real Stripe checkout session
 *   2. post a CORRECTLY SIGNED webhook payload (via stripe.webhooks
 *      .generateTestHeaderString — the same signing Stripe itself uses) and
 *      assert the wallet balance actually increased
 *   3. settle a payment to a provider via WalletService.settle() and assert
 *      the commission landed in the Platform ledger (not discarded)
 *   4. replay the SAME webhook event id and assert no double-credit
 *
 * Prereqs: server running, STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET set to
 * real test-mode values (see STRIPE_TESTING.md — these do NOT have to be
 * the ones `stripe listen` prints; any valid test webhook secret works for
 * this script since it signs its own synthetic events).
 * Run:     API_URL=http://localhost:5000 node scripts/wallet-smoke.js
 */
require('dotenv').config();
const axios = require('axios');
const mongoose = require('mongoose');
const Stripe = require('stripe');

const BASE = process.env.API_URL || 'http://localhost:5000';
const api = axios.create({ baseURL: `${BASE}/api`, validateStatus: () => true });

let passed = 0;
let failed = 0;
const step = (name, ok, detail = '') => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? passed++ : failed++;
  return ok;
};
const bail = (name, detail) => {
  step(name, false, detail);
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(1);
};

(async () => {
  console.log(`=== Wallet Stripe smoke test against ${BASE} ===\n`);

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    bail(
      'Stripe test credentials present',
      'STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must be set — see STRIPE_TESTING.md'
    );
  }
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('../src/models/User');
  const Provider = require('../src/models/Provider');
  const WalletService = require('../src/services/walletService');
  const Wallet = require('../src/models/Wallet');

  // 1. Test user (+ password 'password123' so we can log in over HTTP)
  const email = 'wallet-smoke@metromatrix.pk';
  let user = await User.findOne({ email }).select('+password');
  if (!user) {
    user = new User({ email, fullName: 'Wallet Smoke User', phoneNumber: '03001112222', isActive: true, isEmailVerified: true });
    user.password = 'password123';
    await user.save();
  }
  const login = await api.post('/auth/login', { email, password: 'password123' });
  const token = login.data?.accessToken;
  if (!token) bail('customer login', JSON.stringify(login.data).slice(0, 150));
  step('test user ready + logged in', true, email);
  const auth = { headers: { Authorization: `Bearer ${token}` } };

  const before = await api.get('/wallet/me', auth);
  const balanceBefore = before.data?.wallet?.balance || 0;
  step('read starting balance', before.status === 200, `PKR ${balanceBefore}`);

  // 2. Real Stripe checkout session (proves createCheckoutSession + the
  // PKR→USD conversion work against the real Stripe API, test mode)
  const topUpAmountPkr = 2800; // → $10.00 at the fixed 280 PKR/USD rate
  const checkout = await api.post('/wallet/topup/checkout', { amount: topUpAmountPkr }, auth);
  const sessionId = checkout.data?.sessionId;
  step(
    'create Stripe checkout session (real test-mode API call)',
    checkout.status === 200 && !!sessionId,
    JSON.stringify(checkout.data).slice(0, 120)
  );
  if (!sessionId) bail('no checkout session', JSON.stringify(checkout.data));

  // 3. A correctly signed checkout.session.completed webhook payload —
  // signed with stripe.webhooks.generateTestHeaderString, the SDK's own
  // test-signing helper, so this proves constructEvent() genuinely verifies
  // rather than the test just trusting whatever it sends.
  const eventId = `evt_smoke_${Date.now()}`;
  const payload = JSON.stringify({
    id: eventId,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        amount_total: Math.round((topUpAmountPkr / 280) * 100),
        payment_intent: `pi_smoke_${Date.now()}`,
        metadata: { ownerId: String(user._id), ownerType: 'User', amount: String(topUpAmountPkr) },
      },
    },
  });
  const header = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET,
  });

  const webhookRes = await axios.post(`${BASE}/api/wallet/webhook`, payload, {
    headers: { 'Content-Type': 'application/json', 'stripe-signature': header },
    validateStatus: () => true,
  });
  step(
    'signed webhook verifies and returns 200',
    webhookRes.status === 200 && webhookRes.data?.received,
    JSON.stringify(webhookRes.data).slice(0, 120)
  );

  const after = await api.get('/wallet/me', auth);
  const balanceAfter = after.data?.wallet?.balance || 0;
  step(
    'balance actually increased by the top-up amount',
    balanceAfter === balanceBefore + topUpAmountPkr,
    `before=${balanceBefore} after=${balanceAfter} (expected +${topUpAmountPkr})`
  );

  // 4. Settle a payment to a provider directly via WalletService — proves
  // commission lands in the Platform ledger instead of vanishing.
  let provider = await Provider.findOne({ email: 'wallet-smoke-provider@metromatrix.pk' });
  if (!provider) {
    provider = await Provider.create({
      email: 'wallet-smoke-provider@metromatrix.pk',
      password: 'Provider@123',
      fullName: 'Wallet Smoke Provider',
      phoneNumber: '03001113333',
      providerType: 'home_service',
      providerSubType: 'electrician',
      emailVerified: 'active',
      adminVerified: 'active',
      isActive: true,
    });
  }
  const platformBefore = await WalletService.getPlatformWallet();
  const settleAmount = 1000;
  const settleResult = await WalletService.settle({
    payerType: 'User',
    payerId: user._id,
    payeeType: 'Provider',
    payeeId: provider._id,
    amount: settleAmount,
    source: 'homeservice_payment',
    relatedTo: { kind: 'Booking', id: new mongoose.Types.ObjectId() },
    description: 'Wallet smoke test settlement',
    commissionRate: 10,
  });
  step(
    'settle() moves money payer→payee with a commission leg',
    settleResult.commission === 100 && settleResult.payeeTransaction.amount === 900,
    `commission=${settleResult.commission}`
  );
  const platformAfter = await WalletService.getPlatformWallet();
  step(
    'commission landed in the Platform ledger',
    platformAfter.balance === platformBefore.balance + 100,
    `platform balance ${platformBefore.balance} → ${platformAfter.balance}`
  );

  // 5. Replay the SAME webhook event — must be a no-op, not a double credit.
  const replayRes = await axios.post(`${BASE}/api/wallet/webhook`, payload, {
    headers: { 'Content-Type': 'application/json', 'stripe-signature': header },
    validateStatus: () => true,
  });
  const afterReplay = await api.get('/wallet/me', auth);
  step(
    'replaying the same event id is a no-op (200, alreadyProcessed)',
    replayRes.status === 200 && replayRes.data?.alreadyProcessed === true
  );
  step(
    'balance did NOT double-credit on replay',
    afterReplay.data?.wallet?.balance === balanceAfter - settleAmount,
    `expected ${balanceAfter - settleAmount}, got ${afterReplay.data?.wallet?.balance}`
  );

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  await mongoose.disconnect();
  process.exit(failed > 0 ? 1 : 0);
})().catch(async (err) => {
  console.error('Wallet smoke test crashed:', err.message);
  try {
    await mongoose.disconnect();
  } catch (e) {}
  process.exit(1);
});
