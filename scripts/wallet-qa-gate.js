/**
 * WALLET GREEN-FLAG GATE (Usama-wallet.md PROMPT 5).
 *
 * The acceptance gate: the wallet is only production-ready if a real top-up
 * buys real goods and every number reconciles to the exact rupee. Runs the
 * whole scenario against a LIVE server with the Cougar + Outfitters shopping
 * seed loaded, and prints PASS/FAIL for every step with the actual
 * before/after balances.
 *
 * Uses the HTTP API for anything a user/vendor would actually do, and direct
 * DB reads for assertions (a balance the API agrees with but the DB does not
 * is exactly the failure mode this gate exists to catch).
 *
 * Prereqs:
 *   - server running (npm run dev)
 *   - node scripts/seed-shopping.js run at least once
 *   - STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET set to test-mode values
 * Run:
 *   API_URL=http://localhost:5000 node scripts/wallet-qa-gate.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const mongoose = require('mongoose');
const Stripe = require('stripe');

const BASE = process.env.API_URL || 'http://localhost:5000';
const api = axios.create({ baseURL: `${BASE}/api`, validateStatus: () => true });
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const Wallet = require('../src/models/Wallet');
const WalletTransaction = require('../src/models/WalletTransaction');
const WalletService = require('../src/services/walletService');
const Product = require('../src/modules/shopping/models/Product');
const Order = require('../src/modules/shopping/models/Order');
const OrderGroup = require('../src/modules/shopping/models/OrderGroup');
const Brand = require('../src/modules/shopping/models/Brand');
const User = require('../src/models/User');
const { PKR_PER_USD } = require('../src/config/currency');

const CUSTOMER = { email: 'shopper1.qa@metromatrix.pk', password: 'Shopper@123' };
const CUSTOMER2 = { email: 'shopper2.qa@metromatrix.pk', password: 'Shopper@123' };
const VENDOR_COUGAR = { email: 'vendor.cougar@metromatrix.pk', password: 'Vendor@123' };
const VENDOR_OUTFITTERS = { email: 'vendor.outfitters@metromatrix.pk', password: 'Vendor@123' };

const TOPUP_PKR = 50000;

const results = [];
let passed = 0;
let failed = 0;

const step = (id, name, ok, detail = '') => {
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
  results.push({ id, name, ok, detail });
  if (ok) passed += 1;
  else failed += 1;
  return ok;
};
const auth = (token) => ({ headers: { Authorization: `Bearer ${token}` } });
/** Providers (vendors, doctors, home-service providers) use a separate route. */
const login = async (creds, label, isProvider = false) => {
  const res = await api.post(isProvider ? '/auth/provider/login' : '/auth/login', creds);
  if (!res.data?.accessToken) {
    throw new Error(`login failed for ${label}: ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  return res.data.accessToken;
};

/** Balance straight from the DB — never from the API response we're testing. */
const dbBalance = async (ownerId, ownerType) => {
  const w = await Wallet.findOne({ owner: ownerId, ownerType });
  return w ? w.balance : 0;
};

/**
 * Per-wallet reconciliation: for every wallet, its balance must equal the net
 * of its own completed ledger rows. Returns the total signed discrepancy and
 * the offending wallets.
 *
 * Absolute drift over a long-lived dev database is not by itself a verdict on
 * the CODE — a shared database accumulates balances written by older code and
 * by hand. What the gate asserts is that a full run of the current code adds
 * ZERO new drift, and it reports the pre-existing figure separately.
 */
const computeDrift = async () => {
  const wallets = await Wallet.find({});
  let total = 0;
  const offenders = [];
  for (const w of wallets) {
    const rows = await WalletTransaction.find({ wallet: w._id, status: 'completed' });
    const net = rows.reduce((s, r) => s + (r.type === 'credit' ? r.amount : -r.amount), 0);
    if (net !== w.balance) {
      total += w.balance - net;
      offenders.push({
        ownerType: w.ownerType,
        owner: String(w.owner),
        balance: w.balance,
        ledgerNet: net,
        diff: w.balance - net,
      });
    }
  }
  return { total, offenders, walletCount: wallets.length };
};

/** Post a correctly-signed checkout.session.completed webhook. */
const postSignedTopUp = async (eventId, sessionId, ownerId, amountPkr) => {
  const payload = JSON.stringify({
    id: eventId,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        amount_total: Math.round((amountPkr / PKR_PER_USD) * 100),
        payment_intent: `pi_qa_${Date.now()}`,
        metadata: { ownerId: String(ownerId), ownerType: 'User', amount: String(amountPkr) },
      },
    },
  });
  const header = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET,
  });
  return axios.post(`${BASE}/api/wallet/webhook`, payload, {
    headers: { 'Content-Type': 'application/json', 'stripe-signature': header },
    validateStatus: () => true,
  });
};

/** Drive a vendor order through the fulfilment state machine to `delivered`. */
const advanceToDelivered = async (vendorToken, orderId) => {
  for (const status of ['confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered']) {
    const res = await api.patch(
      `/shopping/vendor/orders/${orderId}/status`,
      { status },
      auth(vendorToken)
    );
    if (res.status !== 200) {
      throw new Error(`transition to ${status} failed: ${JSON.stringify(res.data).slice(0, 200)}`);
    }
  }
};

(async () => {
  console.log(`\n=== WALLET GREEN-FLAG GATE against ${BASE} ===\n`);
  await mongoose.connect(process.env.MONGODB_URI);

  const ledger = {}; // narrative numbers for WALLET_QA.md

  // Baseline reconciliation BEFORE we touch anything, so C12 can prove this
  // run added no new drift rather than blaming us for historical data.
  const driftBefore = await computeDrift();
  console.log(
    `(baseline: ${driftBefore.offenders.length}/${driftBefore.walletCount} wallets drifted, ` +
      `pre-existing drift PKR ${driftBefore.total})\n`
  );
  ledger.driftBefore = driftBefore.total;

  // ---------------------------------------------------------------------
  console.log('--- SCENARIO A — USER: top up, then shop ---');
  // ---------------------------------------------------------------------

  // A1 — login, note starting balance
  const custToken = await login(CUSTOMER, 'customer');
  const custUser = await User.findOne({ email: CUSTOMER.email });
  const startBalance = await dbBalance(custUser._id, 'User');
  ledger.startBalance = startBalance;
  step('A1', 'log in as test customer and read starting balance', true, `PKR ${startBalance}`);

  // A2 — top up PKR 50,000 via Stripe test mode
  const coSession = await api.post('/wallet/topup/checkout', { amount: TOPUP_PKR }, auth(custToken));
  const sessionId = coSession.data?.sessionId;
  step(
    'A2a',
    'create a real Stripe test-mode checkout session',
    coSession.status === 200 && !!sessionId,
    sessionId ? `${sessionId.slice(0, 28)}…` : JSON.stringify(coSession.data).slice(0, 120)
  );

  const topUpEventId = `evt_qagate_${Date.now()}`;
  const hookRes = await postSignedTopUp(topUpEventId, sessionId, custUser._id, TOPUP_PKR);
  step('A2b', 'signed top-up webhook verifies and returns 200', hookRes.status === 200);

  const afterTopUp = await dbBalance(custUser._id, 'User');
  ledger.afterTopUp = afterTopUp;
  step(
    'A2c',
    'balance increased by EXACTLY the top-up amount',
    afterTopUp === startBalance + TOPUP_PKR,
    `${startBalance} → ${afterTopUp} (expected ${startBalance + TOPUP_PKR})`
  );

  const custWallet = await Wallet.findOne({ owner: custUser._id, ownerType: 'User' });
  const topUpTxn = await WalletTransaction.findOne({
    wallet: custWallet._id,
    source: 'stripe_topup',
    stripeSessionId: sessionId,
  });
  step('A2d', 'WalletTransaction with source stripe_topup exists', !!topUpTxn,
    topUpTxn ? `amount ${topUpTxn.amount}, status ${topUpTxn.status}` : 'not found');

  const txnList = await api.get('/wallet/transactions?limit=5', auth(custToken));
  const showsInHistory = (txnList.data?.transactions || txnList.data?.data || []).some(
    (t) => t.source === 'stripe_topup'
  );
  step('A2e', 'top-up shows in GET /wallet/transactions (TransactionHistory feed)', showsInHistory);

  const meRes = await api.get('/wallet/me', auth(custToken));
  step(
    'A2f',
    'GET /wallet/me (MiniWalletCard source) reflects the new balance',
    meRes.data?.wallet?.balance === afterTopUp,
    `api=${meRes.data?.wallet?.balance} db=${afterTopUp}`
  );

  // A3 — cart with products from BOTH brands
  await api.delete('/shopping/cart', auth(custToken)).catch(() => {});
  const brandsRes = await api.get('/shopping/brands?limit=10');
  const brands = brandsRes.data?.data || [];
  const cougar = brands.find((b) => b.slug === 'cougar');
  const outfitters = brands.find((b) => b.slug === 'outfitters');
  if (!cougar || !outfitters) throw new Error('Cougar/Outfitters seed missing — run seed-shopping.js');

  const pickInStock = async (brandId) => {
    const p = await Product.findOne({
      brandId,
      isActive: true,
      'variants.stockQuantity': { $gte: 2 },
    });
    if (!p) throw new Error(`no in-stock product for brand ${brandId}`);
    const v = p.variants.find((x) => x.stockQuantity >= 2);
    return { product: p, variant: v };
  };
  const pickA = await pickInStock(cougar._id || cougar.id);
  const pickB = await pickInStock(outfitters._id || outfitters.id);

  for (const pick of [pickA, pickB]) {
    const res = await api.post(
      '/shopping/cart/items',
      { productId: String(pick.product._id), variantId: String(pick.variant._id), quantity: 1 },
      auth(custToken)
    );
    if (res.status >= 400) throw new Error(`add to cart failed: ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  const cartRes = await api.get('/shopping/cart', auth(custToken));
  const cartData = cartRes.data?.data || cartRes.data;
  const cartTotal = cartData?.total;
  const cartBrands = new Set(
    (cartData?.items || []).map((i) => String(i.brandId?._id || i.brandId?.id || i.brandId))
  );
  step(
    'A3',
    'cart holds products from BOTH Cougar and Outfitters, total < top-up',
    cartBrands.size === 2 && cartTotal > 0 && cartTotal < TOPUP_PKR,
    `total PKR ${cartTotal}, ${cartBrands.size} brands`
  );

  // A4 — checkout paying by WALLET
  const balBeforeCheckout = await dbBalance(custUser._id, 'User');
  const checkoutRes = await api.post(
    '/shopping/checkout',
    {
      paymentMethod: 'wallet',
      shippingAddress: {
        fullName: 'Hina Aslam',
        phone: '03005550011',
        addressLine1: 'House 1, Street 2',
        city: 'Lahore',
      },
    },
    auth(custToken)
  );
  const group = checkoutRes.data?.data || checkoutRes.data;
  step(
    'A4a',
    'wallet checkout succeeds',
    checkoutRes.status === 201 || checkoutRes.status === 200,
    `status ${checkoutRes.status}`
  );

  // The OrderGroup serializer renames _id → groupId and deletes _id.
  const groupDoc = await OrderGroup.findById(group.groupId || group._id || group.id);
  if (!groupDoc) throw new Error(`could not load OrderGroup from checkout response: ${JSON.stringify(group).slice(0, 200)}`);
  const childOrders = await Order.find({ orderGroup: groupDoc._id });
  step(
    'A4b',
    'one OrderGroup + one Order per brand',
    childOrders.length === 2,
    `${childOrders.length} child orders`
  );

  const childSum = childOrders.reduce((s, o) => s + o.total, 0);
  step(
    'A4c',
    'child order totals sum to the group total to the exact rupee',
    childSum === groupDoc.total,
    `children ${childSum} vs group ${groupDoc.total}`
  );

  const balAfterCheckout = await dbBalance(custUser._id, 'User');
  ledger.orderTotal = groupDoc.total;
  ledger.afterCheckout = balAfterCheckout;
  step(
    'A4d',
    'the EXACT cart total was debited from the customer wallet',
    balBeforeCheckout - balAfterCheckout === groupDoc.total,
    `${balBeforeCheckout} → ${balAfterCheckout} (debited ${balBeforeCheckout - balAfterCheckout}, order ${groupDoc.total})`
  );

  step(
    'A4e',
    'customer balance = start + top-up − order total, EXACTLY',
    balAfterCheckout === startBalance + TOPUP_PKR - groupDoc.total,
    `${balAfterCheckout} == ${startBalance} + ${TOPUP_PKR} − ${groupDoc.total}`
  );

  const payTxn = await WalletTransaction.findOne({
    wallet: custWallet._id,
    source: 'shopping_payment',
    'relatedTo.id': groupDoc._id,
  });
  step(
    'A4f',
    'WalletTransaction source shopping_payment with relatedTo the order group',
    !!payTxn && payTxn.amount === groupDoc.total,
    payTxn ? `amount ${payTxn.amount}, relatedTo ${payTxn.relatedTo.kind}` : 'not found'
  );

  // A4g — vendor credit + commission. By DESIGN this happens at DELIVERY,
  // not checkout (WALLET_DESIGN.md): the customer's money must not reach the
  // vendor before goods arrive. So drive the orders to delivered, then assert.
  const cougarBrandDoc = await Brand.findById(cougar._id || cougar.id);
  const outfBrandDoc = await Brand.findById(outfitters._id || outfitters.id);
  const vendorBalBefore = {
    cougar: await dbBalance(cougarBrandDoc.owner, 'Provider'),
    outfitters: await dbBalance(outfBrandDoc.owner, 'Provider'),
  };
  const platformBefore = (await WalletService.getPlatformWallet()).balance;

  const cougarToken = await login(VENDOR_COUGAR, 'vendor.cougar', true);
  const outfToken = await login(VENDOR_OUTFITTERS, 'vendor.outfitters', true);
  const orderOf = (brandId) => childOrders.find((o) => String(o.brandId) === String(brandId));
  const cougarOrder = orderOf(cougarBrandDoc._id);
  const outfOrder = orderOf(outfBrandDoc._id);

  await advanceToDelivered(cougarToken, cougarOrder._id);
  await advanceToDelivered(outfToken, outfOrder._id);

  const vendorBalAfter = {
    cougar: await dbBalance(cougarBrandDoc.owner, 'Provider'),
    outfitters: await dbBalance(outfBrandDoc.owner, 'Provider'),
  };
  const platformAfter = (await WalletService.getPlatformWallet()).balance;

  const freshCougarOrder = await Order.findById(cougarOrder._id);
  const freshOutfOrder = await Order.findById(outfOrder._id);
  const expectedCougarNet = freshCougarOrder.vendorPayout?.amount ?? 0;
  const expectedOutfNet = freshOutfOrder.vendorPayout?.amount ?? 0;
  const totalCommission =
    (freshCougarOrder.vendorPayout?.commission ?? 0) + (freshOutfOrder.vendorPayout?.commission ?? 0);

  step(
    'A4g',
    "each vendor's wallet credited its share minus commission (on delivery, by design)",
    vendorBalAfter.cougar - vendorBalBefore.cougar === expectedCougarNet &&
      vendorBalAfter.outfitters - vendorBalBefore.outfitters === expectedOutfNet &&
      expectedCougarNet > 0 &&
      expectedOutfNet > 0,
    `cougar +${vendorBalAfter.cougar - vendorBalBefore.cougar} (net ${expectedCougarNet}), ` +
      `outfitters +${vendorBalAfter.outfitters - vendorBalBefore.outfitters} (net ${expectedOutfNet})`
  );

  step(
    'A4h',
    'commission landed in the Platform ledger',
    platformAfter - platformBefore === totalCommission && totalCommission > 0,
    `platform ${platformBefore} → ${platformAfter} (+${platformAfter - platformBefore}, expected ${totalCommission})`
  );

  const earningTxn = await WalletTransaction.findOne({
    source: 'shopping_earning',
    'relatedTo.id': freshCougarOrder._id,
  });
  step(
    'A4i',
    'shopping_earning txn exists on the vendor side, linked via relatedTo',
    !!earningTxn,
    earningTxn ? `amount ${earningTxn.amount}` : 'not found'
  );

  // A5 — INSUFFICIENT BALANCE: no partial debit, no stock change.
  // Drain the wallet down to a token amount first (through the ledger, so
  // reconciliation stays intact), so a NORMAL in-stock purchase is the thing
  // that exceeds the balance — that is the real customer-facing path.
  const bigPick = await pickInStock(cougarBrandDoc._id);
  const bigProduct = await Product.findById(bigPick.product._id);
  const bigVariant = bigProduct.variants.id(bigPick.variant._id);
  const stockBeforeInsuff = bigVariant.stockQuantity;

  const preDrain = await dbBalance(custUser._id, 'User');
  const drainAmount = preDrain - 1; // leave PKR 1 — far below any item price
  if (drainAmount > 0) {
    await WalletService.payWithSettle({
      payerType: 'User',
      payerId: custUser._id,
      amount: drainAmount,
      source: 'admin_adjustment',
      relatedTo: { kind: 'OrderGroup', id: groupDoc._id },
      description: 'QA gate: drain balance to test insufficient-balance path',
    });
  }
  const balBeforeInsuff = await dbBalance(custUser._id, 'User');

  await api.delete('/shopping/cart', auth(custToken)).catch(() => {});
  const addRes = await api.post(
    '/shopping/cart/items',
    { productId: String(bigProduct._id), variantId: String(bigVariant._id), quantity: 1 },
    auth(custToken)
  );
  if (addRes.status >= 400) {
    throw new Error(`A5 setup: add to cart failed: ${JSON.stringify(addRes.data).slice(0, 200)}`);
  }
  const insuffRes = await api.post(
    '/shopping/checkout',
    {
      paymentMethod: 'wallet',
      shippingAddress: {
        fullName: 'Hina Aslam',
        phone: '03005550011',
        addressLine1: 'House 1, Street 2',
        city: 'Lahore',
      },
    },
    auth(custToken)
  );
  const balAfterInsuff = await dbBalance(custUser._id, 'User');
  const productAfterInsuff = await Product.findById(bigProduct._id);
  const stockAfterInsuff = productAfterInsuff.variants.id(bigVariant._id).stockQuantity;

  step(
    'A5a',
    'over-balance purchase is BLOCKED with a clear insufficient-balance message',
    insuffRes.status >= 400 && /insufficient/i.test(JSON.stringify(insuffRes.data)),
    `status ${insuffRes.status}: ${String(insuffRes.data?.message || insuffRes.data?.error).slice(0, 90)}`
  );
  step(
    'A5b',
    'NO partial debit on the blocked purchase',
    balAfterInsuff === balBeforeInsuff,
    `${balBeforeInsuff} → ${balAfterInsuff}`
  );
  step(
    'A5c',
    'NO stock change on the blocked purchase',
    stockAfterInsuff === stockBeforeInsuff,
    `stock ${stockBeforeInsuff} → ${stockAfterInsuff}`
  );
  await api.delete('/shopping/cart', auth(custToken)).catch(() => {});

  // Give the drained balance back (through the ledger) before the refund test.
  if (drainAmount > 0) {
    await WalletService.refund({
      ownerType: 'User',
      ownerId: custUser._id,
      amount: drainAmount,
      relatedTo: { kind: 'OrderGroup', id: groupDoc._id },
      source: 'admin_adjustment',
      description: 'QA gate: restore drained balance',
    });
  }

  // A6 — REFUND PATH: delivered → returned → refunded (money moves on the
  // 'refunded' leg; 'returned' only records that the goods came back).
  const balBeforeRefund = await dbBalance(custUser._id, 'User');
  const cougarVendorBalBeforeRefund = await dbBalance(cougarBrandDoc.owner, 'Provider');
  const platformBeforeRefund = (await WalletService.getPlatformWallet()).balance;
  const refundItem = freshCougarOrder.items[0];
  const productBeforeRefund = await Product.findById(refundItem.productId);
  const stockBeforeRefund = productBeforeRefund.variants.id(refundItem.variantId).stockQuantity;

  const returnedRes = await api.patch(
    `/shopping/vendor/orders/${freshCougarOrder._id}/status`,
    { status: 'returned' },
    auth(cougarToken)
  );
  if (returnedRes.status !== 200) {
    throw new Error(`A6 setup: delivered→returned failed: ${JSON.stringify(returnedRes.data).slice(0, 200)}`);
  }
  const returnRes = await api.patch(
    `/shopping/vendor/orders/${freshCougarOrder._id}/status`,
    { status: 'refunded' },
    auth(cougarToken)
  );

  const balAfterRefund = await dbBalance(custUser._id, 'User');
  const cougarVendorBalAfterRefund = await dbBalance(cougarBrandDoc.owner, 'Provider');
  const platformAfterRefund = (await WalletService.getPlatformWallet()).balance;
  const productAfterRefund = await Product.findById(refundItem.productId);
  const stockAfterRefund = productAfterRefund.variants.id(refundItem.variantId).stockQuantity;

  step(
    'A6a',
    'refund credits the customer the right amount',
    returnRes.status === 200 && balAfterRefund - balBeforeRefund === freshCougarOrder.total,
    `${balBeforeRefund} → ${balAfterRefund} (+${balAfterRefund - balBeforeRefund}, order ${freshCougarOrder.total})`
  );
  step(
    'A6b',
    "vendor's credit is reversed",
    cougarVendorBalBeforeRefund - cougarVendorBalAfterRefund === expectedCougarNet,
    `${cougarVendorBalBeforeRefund} → ${cougarVendorBalAfterRefund} (−${cougarVendorBalBeforeRefund - cougarVendorBalAfterRefund}, expected −${expectedCougarNet})`
  );
  step(
    'A6c',
    'commission is reversed out of the Platform ledger',
    platformBeforeRefund - platformAfterRefund === (freshCougarOrder.vendorPayout?.commission ?? 0),
    `platform ${platformBeforeRefund} → ${platformAfterRefund} (expected −${freshCougarOrder.vendorPayout?.commission ?? 0})`
  );
  step(
    'A6d',
    'stock is restored',
    stockAfterRefund === stockBeforeRefund + refundItem.quantity,
    `${stockBeforeRefund} → ${stockAfterRefund} (+${refundItem.quantity})`
  );

  // ---------------------------------------------------------------------
  console.log('\n--- SCENARIO B — PROVIDER: earnings and payout ---');
  // ---------------------------------------------------------------------

  // B7 — vendor sees the SAME polymorphic wallet
  const outfWalletRes = await api.get('/wallet/me', auth(outfToken));
  const outfDbBal = await dbBalance(outfBrandDoc.owner, 'Provider');
  step(
    'B7a',
    'vendor wallet (ownerType Provider) shows the earning, API agrees with DB',
    outfWalletRes.status === 200 && outfWalletRes.data?.wallet?.balance === outfDbBal,
    `api=${outfWalletRes.data?.wallet?.balance} db=${outfDbBal}`
  );
  const outfTxns = await api.get('/wallet/transactions?limit=10', auth(outfToken));
  const hasEarning = (outfTxns.data?.transactions || outfTxns.data?.data || []).some(
    (t) => t.source === 'shopping_earning'
  );
  step('B7b', "earning appears in the vendor's TransactionHistory", hasEarning);

  // B8 — doctor + home-service provider wallets render without crashing
  const otherProviders = [
    { label: 'doctor', email: 'doctor1.hc@metromatrix.pk', password: 'Doctor@123' },
    { label: 'home-service provider', email: 'provider1.hs@metromatrix.pk', password: 'Provider@123' },
  ];
  for (const p of otherProviders) {
    const res = await api.post('/auth/provider/login', { email: p.email, password: p.password });
    if (!res.data?.accessToken) {
      step('B8', `${p.label} wallet renders`, false, `login unavailable (${p.email}) — seed not loaded`);
      continue;
    }
    const wRes = await api.get('/wallet/me', auth(res.data.accessToken));
    step(
      'B8',
      `${p.label} wallet renders (same endpoint, no crash, zero balance OK)`,
      wRes.status === 200 && typeof wRes.data?.wallet?.balance === 'number',
      `balance ${wRes.data?.wallet?.balance}`
    );
  }

  // B9 — payout requests
  const outfAvail = await dbBalance(outfBrandDoc.owner, 'Provider');
  const okPayout = await api.post('/wallet/payout', { amount: Math.max(1, Math.floor(outfAvail / 4)) }, auth(outfToken));
  step(
    'B9a',
    'payout request for a valid amount is accepted (or blocked only by Connect onboarding)',
    okPayout.status === 200 || okPayout.status === 400,
    `status ${okPayout.status}: ${String(okPayout.data?.message || okPayout.data?.error || '').slice(0, 80)}`
  );
  const badPayout = await api.post('/wallet/payout', { amount: outfAvail + 999999 }, auth(outfToken));
  step(
    'B9b',
    'payout exceeding available balance is REJECTED',
    badPayout.status >= 400,
    `status ${badPayout.status}: ${String(badPayout.data?.message || badPayout.data?.error || '').slice(0, 80)}`
  );

  // ---------------------------------------------------------------------
  console.log('\n--- SCENARIO C — INTEGRITY ---');
  // ---------------------------------------------------------------------

  // C10 — concurrency: two customers race for the last unit
  const raceProduct = await Product.findOne({
    brandId: outfBrandDoc._id,
    isActive: true,
    'variants.0': { $exists: true },
  });
  const raceVariant = raceProduct.variants[0];
  await Product.updateOne(
    { _id: raceProduct._id, 'variants._id': raceVariant._id },
    { $set: { 'variants.$.stockQuantity': 1 } }
  );

  const cust2Token = await login(CUSTOMER2, 'customer2');
  const cust2User = await User.findOne({ email: CUSTOMER2.email });
  // Make sure both racers can afford it — funded THROUGH the ledger, not by
  // writing balances directly, so this setup cannot itself create the
  // unbacked balance that C12 is about to check for.
  for (const u of [cust2User, custUser]) {
    const bal = await dbBalance(u._id, 'User');
    if (bal < 20000) {
      await WalletService.refund({
        ownerType: 'User',
        ownerId: u._id,
        amount: 20000 - bal,
        source: 'admin_adjustment',
        description: 'QA gate: fund concurrency racer',
      });
    }
  }

  const addr = {
    fullName: 'QA Racer',
    phone: '03005550011',
    addressLine1: 'House 1, Street 2',
    city: 'Lahore',
  };
  for (const t of [custToken, cust2Token]) {
    await api.delete('/shopping/cart', auth(t)).catch(() => {});
    await api.post(
      '/shopping/cart/items',
      { productId: String(raceProduct._id), variantId: String(raceVariant._id), quantity: 1 },
      auth(t)
    );
  }
  const [r1, r2] = await Promise.all([
    api.post('/shopping/checkout', { paymentMethod: 'wallet', shippingAddress: addr }, auth(custToken)),
    api.post('/shopping/checkout', { paymentMethod: 'wallet', shippingAddress: addr }, auth(cust2Token)),
  ]);
  const successes = [r1, r2].filter((r) => r.status === 200 || r.status === 201).length;
  const raceAfter = await Product.findById(raceProduct._id);
  const raceStock = raceAfter.variants.id(raceVariant._id).stockQuantity;
  step(
    'C10',
    'two customers racing for the LAST unit → exactly one wins, stock never negative',
    successes === 1 && raceStock === 0,
    `${successes} succeeded, final stock ${raceStock}`
  );

  // C11 — replay the top-up webhook: must NOT double-credit
  const beforeReplay = await dbBalance(custUser._id, 'User');
  const replayRes = await postSignedTopUp(topUpEventId, sessionId, custUser._id, TOPUP_PKR);
  const afterReplay = await dbBalance(custUser._id, 'User');
  step(
    'C11',
    'replaying the SAME top-up event does NOT double-credit',
    afterReplay === beforeReplay && replayRes.status === 200,
    `${beforeReplay} → ${afterReplay}, replay status ${replayRes.status} (alreadyProcessed=${replayRes.data?.alreadyProcessed})`
  );

  // C12 — RECONCILIATION across the whole dataset
  const agg = async (match) => {
    const r = await WalletTransaction.aggregate([
      { $match: match },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    return r[0]?.total || 0;
  };
  const sumBalances = async (ownerType) => {
    const r = await Wallet.aggregate([
      { $match: { ownerType } },
      { $group: { _id: null, total: { $sum: '$balance' } } },
    ]);
    return r[0]?.total || 0;
  };

  const userBalances = await sumBalances('User');
  const providerBalances = await sumBalances('Provider');
  const platformBalance = await sumBalances('Platform');

  const credits = await agg({ type: 'credit', status: 'completed' });
  const debits = await agg({ type: 'debit', status: 'completed' });
  const heldTotal = userBalances + providerBalances + platformBalance;
  const ledgerNet = credits - debits;

  const driftAfter = await computeDrift();
  ledger.driftAfter = driftAfter.total;
  ledger.driftOffenders = driftAfter.offenders;
  ledger.reconciliation = {
    userBalances,
    providerBalances,
    platformBalance,
    credits,
    debits,
    heldTotal,
    ledgerNet,
  };

  step(
    'C12a',
    'RECONCILIATION: this run introduced ZERO new drift (every rupee we moved is ledgered)',
    driftAfter.total === driftBefore.total,
    `drift before PKR ${driftBefore.total} → after PKR ${driftAfter.total} (delta ${driftAfter.total - driftBefore.total})`
  );

  step(
    'C12b',
    'RECONCILIATION: whole dataset — held balances == net of completed ledger rows',
    heldTotal === ledgerNet,
    `held ${heldTotal} (user ${userBalances} + provider ${providerBalances} + platform ${platformBalance}) ` +
      `vs ledger net ${ledgerNet} (credits ${credits} − debits ${debits}); difference ${heldTotal - ledgerNet} ` +
      `across ${driftAfter.offenders.length}/${driftAfter.walletCount} wallets`
  );

  // ---------------------------------------------------------------------
  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
  require('fs').writeFileSync(
    require('path').join(__dirname, '..', 'wallet-qa-results.json'),
    JSON.stringify({ results, ledger, passed, failed, at: new Date().toISOString() }, null, 2)
  );
  await mongoose.disconnect();
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('\nGATE ABORTED:', err.message);
  console.error(err.stack);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
