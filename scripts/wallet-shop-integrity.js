/**
 * Wallet integrity sweep for the shopping money paths.
 *
 * Silent money bugs pass a demo and fail an audit, so this asserts the ledger
 * invariants directly rather than trusting an API's 200. Every check is
 * PASS/FAIL with the arithmetic shown.
 *
 *   1. WALLET CONSERVATION   — customer debit == vendor credits + commission
 *   2. INSUFFICIENT BALANCE  — over-balance purchase: no debit, no stock change
 *   3. REFUND CORRECTNESS    — refund reverses customer, vendor and commission,
 *                              and restores stock exactly
 *   4. DOUBLE PAY / REFUND   — neither can be replayed onto the ledger
 *   5. TOP-UP IDEMPOTENCY    — replaying a Stripe webhook does not double-credit
 *   6. RECONCILIATION        — every wallet's balance equals the sum of its own
 *                              ledger rows, and the shopping legs net to zero
 *
 * Prereqs: server running, `node scripts/seed-shopping.js` run once.
 * Run:     API_URL=http://localhost:5000 node scripts/wallet-shop-integrity.js
 *
 * SAFETY: this script places orders, moves money and mutates stock. Point it at
 * a disposable database — never the production cluster. It refuses to run
 * against a MONGODB_URI it can see is a hosted Atlas cluster unless
 * ALLOW_REMOTE_DB=true is set explicitly.
 */
require('dotenv').config();
const axios = require('axios');
const mongoose = require('mongoose');

const BASE = process.env.API_URL || 'http://localhost:5000';
const api = axios.create({ baseURL: `${BASE}/api`, validateStatus: () => true });

const Wallet = require('../src/models/Wallet');
const WalletTransaction = require('../src/models/WalletTransaction');
const WalletService = require('../src/services/walletService');
const Order = require('../src/modules/shopping/models/Order');
const OrderGroup = require('../src/modules/shopping/models/OrderGroup');
const Product = require('../src/modules/shopping/models/Product');
const Brand = require('../src/modules/shopping/models/Brand');
const { getShoppingSettings } = require('../src/modules/shopping/services/settingsService');

const CUSTOMER = { email: 'shopper1.qa@metromatrix.pk', password: 'Shopper@123' };
const VENDORS = [
  { email: 'vendor.cougar@metromatrix.pk', password: 'Vendor@123', brand: 'Cougar' },
  { email: 'vendor.outfitters@metromatrix.pk', password: 'Vendor@123', brand: 'Outfitters' },
];

let passed = 0;
let failed = 0;
const rows = [];
const check = (name, ok, detail = '') => {
  rows.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? (passed += 1) : (failed += 1);
  return ok;
};

const auth = (t) => ({ headers: { Authorization: `Bearer ${t}` } });
const balanceOf = async (ownerId) => {
  const w = await Wallet.findOne({ owner: ownerId });
  return w ? w.balance : 0;
};

async function login(email, password, provider = false) {
  const r = await api.post(provider ? '/auth/provider/login' : '/auth/login', { email, password });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.data)}`);
  return { token: r.data.accessToken, id: r.data.user?.id || r.data.provider?.id };
}

/** Fill a cart with in-stock lines from the given brands. */
async function buildCart(token, brandIds, linesPerBrand = 1) {
  await api.delete('/shopping/cart', auth(token));
  const picked = [];
  for (const brandId of brandIds) {
    const list = await api.get(`/shopping/products?brandId=${brandId}&limit=40`, auth(token));
    let n = 0;
    for (const s of list.data.data) {
      if (n >= linesPerBrand) break;
      const d = await api.get(`/shopping/products/${s.productId}`, auth(token));
      const v = (d.data.data.variants || []).find((x) => (x.stockQuantity ?? 0) > 3);
      if (!v) continue;
      const add = await api.post('/shopping/cart/items',
        { productId: d.data.data.productId, variantId: v.variantId, quantity: 2 }, auth(token));
      if (add.status < 300) { picked.push({ productId: d.data.data.productId, variantId: v.variantId, quantity: 2 }); n += 1; }
    }
  }
  const cart = await api.get('/shopping/cart', auth(token));
  return { cart: cart.data.data, picked };
}

const stockOf = async (productId, variantId) => {
  const p = await Product.findById(productId);
  return p.variants.id(variantId).stockQuantity;
};

async function ensureAddress(token) {
  const list = await api.get('/shopping/addresses', auth(token));
  if (list.data.data?.length) return list.data.data[0].addressId || list.data.data[0]._id;
  const mk = await api.post('/shopping/addresses', {
    fullName: 'Integrity Check', phone: '03001112223', addressLine1: '1 Ledger Way',
    city: 'Lahore', country: 'Pakistan', isDefault: true,
  }, auth(token));
  return mk.data.data.addressId || mk.data.data._id;
}

async function driveToDelivered(orderId, vendorToken) {
  for (const status of ['confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered']) {
    await api.patch(`/shopping/vendor/orders/${orderId}/status`, { status }, auth(vendorToken));
  }
}

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  if (/mongodb\+srv|mongodb\.net/.test(uri) && process.env.ALLOW_REMOTE_DB !== 'true') {
    console.error('\nRefusing to run: MONGODB_URI points at a hosted cluster.');
    console.error('This script places orders and moves money. Point it at a disposable database,');
    console.error('or set ALLOW_REMOTE_DB=true if you genuinely mean to run it there.\n');
    process.exit(2);
  }
  await mongoose.connect(uri);
  console.log(`\nWallet/shopping integrity sweep against ${BASE}\n`);

  const settings = await getShoppingSettings();
  const commissionPercent = settings.commissionPercent;
  const customer = await login(CUSTOMER.email, CUSTOMER.password);
  const customerId = new mongoose.Types.ObjectId(customer.id);
  const addressId = await ensureAddress(customer.token);

  const vendors = {};
  for (const v of VENDORS) {
    const brand = await Brand.findOne({ name: v.brand });
    if (!brand) continue;
    vendors[v.brand] = { ...(await login(v.email, v.password, true)), brand };
  }
  const brandIds = Object.values(vendors).map((v) => String(v.brand._id));
  const platformWallet = await WalletService.getPlatformWallet();

  // ── 1. WALLET CONSERVATION ────────────────────────────────────────
  const custBefore = await balanceOf(customerId);
  const vendorBefore = {};
  for (const [name, v] of Object.entries(vendors)) vendorBefore[name] = await balanceOf(v.brand.owner);
  const platformBefore = (await Wallet.findById(platformWallet._id)).balance;

  const { cart } = await buildCart(customer.token, brandIds);
  const co = await api.post('/shopping/checkout', { addressId, paymentMethod: 'wallet' }, auth(customer.token));
  if (co.status >= 300) {
    check('1. WALLET CONSERVATION', false, `checkout failed: ${co.status} ${JSON.stringify(co.data)}`);
  } else {
    const group = await OrderGroup.findById(co.data.data.groupId);
    const kids = await Order.find({ orderGroup: group._id });
    const custAfterPay = await balanceOf(customerId);
    const debited = custBefore - custAfterPay;

    check('1a. customer debited exactly the order total',
      debited === group.total, `debited ${debited}, order total ${group.total}`);
    check('1b. per-brand orders sum to the group total',
      kids.reduce((s, o) => s + o.total, 0) === group.total,
      `Σ children ${kids.reduce((s, o) => s + o.total, 0)} == group ${group.total}`);

    // vendors are credited on delivery, so drive each child order there
    for (const kid of kids) {
      const v = Object.values(vendors).find((x) => String(x.brand._id) === String(kid.brandId));
      if (v) await driveToDelivered(kid._id, v.token);
    }

    let vendorCredited = 0;
    for (const [name, v] of Object.entries(vendors)) {
      vendorCredited += (await balanceOf(v.brand.owner)) - vendorBefore[name];
    }
    const platformAfter = (await Wallet.findById(platformWallet._id)).balance;
    const commissionTaken = platformAfter - platformBefore;
    const expectedCommission = kids.reduce((s, o) => s + Math.round((o.total * commissionPercent) / 100), 0);

    check('1c. commission credited to the Platform ledger matches the rate',
      commissionTaken === expectedCommission,
      `platform +${commissionTaken}, expected ${expectedCommission} (${commissionPercent}%)`);
    check('1d. CONSERVATION: customer debit == vendor credits + commission',
      debited === vendorCredited + commissionTaken,
      `${debited} == ${vendorCredited} + ${commissionTaken}`);

    global.__conservationOrder = kids[0];
  }

  // ── 2. INSUFFICIENT BALANCE ───────────────────────────────────────
  {
    const { picked } = await buildCart(customer.token, [brandIds[0]]);
    const stockBefore = await Promise.all(picked.map((p) => stockOf(p.productId, p.variantId)));
    const realBalance = await balanceOf(customerId);
    await Wallet.updateOne({ owner: customerId }, { $set: { balance: 1 } });

    const attempt = await api.post('/shopping/checkout', { addressId, paymentMethod: 'wallet' }, auth(customer.token));
    const balAfter = await balanceOf(customerId);
    const stockAfter = await Promise.all(picked.map((p) => stockOf(p.productId, p.variantId)));

    check('2a. over-balance purchase is rejected', attempt.status >= 400,
      `HTTP ${attempt.status} ${attempt.data?.error || ''}`);
    check('2b. no debit occurred', balAfter === 1, `balance still ${balAfter}`);
    check('2c. no stock was consumed',
      stockBefore.every((s, i) => s === stockAfter[i]),
      `before [${stockBefore}] after [${stockAfter}]`);

    await Wallet.updateOne({ owner: customerId }, { $set: { balance: realBalance } });
    await api.delete('/shopping/cart', auth(customer.token));
  }

  // ── 3. REFUND CORRECTNESS ─────────────────────────────────────────
  {
    const brandName = Object.keys(vendors)[0];
    const v = vendors[brandName];
    const { picked } = await buildCart(customer.token, [String(v.brand._id)]);
    const stockPreOrder = await stockOf(picked[0].productId, picked[0].variantId);
    const co3 = await api.post('/shopping/checkout', { addressId, paymentMethod: 'wallet' }, auth(customer.token));
    const order = await Order.findOne({ orderGroup: co3.data.data.groupId });

    await driveToDelivered(order._id, v.token);
    const delivered = await Order.findById(order._id);
    const custPre = await balanceOf(customerId);
    const vendPre = await balanceOf(v.brand.owner);
    const platPre = (await Wallet.findById(platformWallet._id)).balance;
    const commission = delivered.vendorPayout?.commission ?? Math.round((delivered.total * commissionPercent) / 100);

    // customer requests, vendor approves → picked_up → refunded
    await api.post(`/shopping/orders/${order._id}/return`, { reason: 'integrity sweep' }, auth(customer.token));
    const ReturnRequest = require('../src/modules/shopping/models/ReturnRequest');
    const rr = await ReturnRequest.findOne({ order: order._id, status: 'requested' });
    for (const status of ['approved', 'picked_up', 'refunded']) {
      await api.patch(`/shopping/vendor/returns/${rr._id}`, { status }, auth(v.token));
    }

    const custPost = await balanceOf(customerId);
    const vendPost = await balanceOf(v.brand.owner);
    const platPost = (await Wallet.findById(platformWallet._id)).balance;
    const stockPost = await stockOf(picked[0].productId, picked[0].variantId);

    check('3a. customer credited the exact order total',
      custPost - custPre === delivered.total, `+${custPost - custPre}, order total ${delivered.total}`);
    check('3b. vendor credit reversed',
      vendPre - vendPost === delivered.total - commission,
      `-${vendPre - vendPost}, expected -${delivered.total - commission}`);
    check('3c. commission reversed out of the Platform ledger',
      platPre - platPost === commission, `-${platPre - platPost}, expected -${commission}`);
    check('3d. stock restored exactly (no double-restore)',
      stockPost === stockPreOrder, `stock ${stockPost}, pre-order ${stockPreOrder}`);

    global.__refundedOrder = delivered;
    global.__refundedReturn = rr;
    global.__refundVendor = v;
  }

  // ── 4. DOUBLE PAY / DOUBLE REFUND ─────────────────────────────────
  {
    const order = global.__refundedOrder;
    const rr = global.__refundedReturn;
    const v = global.__refundVendor;

    const custPre = await balanceOf(customerId);
    const txPre = await WalletTransaction.countDocuments({ 'relatedTo.id': order._id });

    const replayRefund = await api.patch(`/shopping/vendor/returns/${rr._id}`, { status: 'refunded' }, auth(v.token));
    const custPost = await balanceOf(customerId);
    const txPost = await WalletTransaction.countDocuments({ 'relatedTo.id': order._id });

    check('4a. replaying the refund is rejected', replayRefund.status >= 400,
      `HTTP ${replayRefund.status} ${replayRefund.data?.error || ''}`);
    check('4b. replay left the balance untouched', custPost === custPre, `${custPre} -> ${custPost}`);
    check('4c. replay wrote no extra ledger rows', txPost === txPre, `${txPre} -> ${txPost}`);

    // double pay: checking out an already-emptied cart must not charge again
    const balPre = await balanceOf(customerId);
    const emptyCheckout = await api.post('/shopping/checkout', { addressId, paymentMethod: 'wallet' }, auth(customer.token));
    const balPost = await balanceOf(customerId);
    check('4d. checking out an empty cart is rejected, with no debit',
      emptyCheckout.status >= 400 && balPost === balPre,
      `HTTP ${emptyCheckout.status}, balance ${balPre} -> ${balPost}`);
  }

  // ── 5. TOP-UP IDEMPOTENCY ─────────────────────────────────────────
  {
    const sessionId = `cs_test_integrity_${Date.now()}`;
    const session = {
      id: sessionId,
      amount_total: 1000, // USD cents; converted to PKR by the service
      payment_intent: `pi_test_${Date.now()}`,
      metadata: { ownerId: String(customerId), ownerType: 'User' },
    };
    const pre = await balanceOf(customerId);
    await WalletService.applyTopUp(session);
    const afterFirst = await balanceOf(customerId);
    const credited = afterFirst - pre;
    check('5a. top-up credits the wallet', credited > 0, `+${credited} PKR from ${session.amount_total} USD cents`);

    await WalletService.applyTopUp(session); // replay the same webhook event
    const afterReplay = await balanceOf(customerId);
    check('5b. replaying the same webhook does NOT double-credit',
      afterReplay === afterFirst, `${afterFirst} -> ${afterReplay}`);
    const dupes = await WalletTransaction.countDocuments({ stripeSessionId: sessionId });
    check('5c. only one ledger row exists for the session', dupes === 1, `${dupes} rows for ${sessionId}`);
  }

  // ── 6. RECONCILIATION ─────────────────────────────────────────────
  {
    // Every wallet's balance must equal the sum of its own completed rows.
    const wallets = await Wallet.find({});
    const drifted = [];
    for (const w of wallets) {
      const txns = await WalletTransaction.find({ wallet: w._id, status: 'completed' });
      const derived = txns.reduce((s, t) => s + (t.type === 'credit' ? t.amount : -t.amount), 0);
      if (derived !== w.balance) {
        drifted.push(`${w.ownerType}:${String(w.owner).slice(-6)} balance ${w.balance} vs ledger ${derived}`);
      }
    }
    check('6a. every wallet balance equals the sum of its ledger rows',
      drifted.length === 0, drifted.length ? drifted.join('; ') : `${wallets.length} wallets reconcile`);

    // Money is only created by an external top-up and only leaves by a payout.
    // Everything in between — payments, earnings, commission, refunds — is an
    // internal move and must cancel out. Two legitimate adjustments apply:
    //
    //   in transit  a wallet order debits the customer at checkout but credits
    //               the vendor only at delivery, so between the two it sits in
    //               no wallet and must be subtracted;
    //   COD settled cash was collected offline, so the vendor is credited at
    //               delivery with no matching wallet debit — it must be added.
    //
    // Both are properties of the design, not slack in the maths: with them the
    // identity has to hold exactly, and any residual is money created or lost.
    const sum = async (q) => (await WalletTransaction.aggregate([
      { $match: { status: 'completed', ...q } },
      { $group: { _id: null, n: { $sum: '$amount' } } },
    ]))[0]?.n || 0;

    const totalBalances = (await Wallet.aggregate([
      { $group: { _id: null, n: { $sum: '$balance' } } },
    ]))[0]?.n || 0;
    const externalIn = await sum({ source: { $in: ['stripe_topup', 'admin_adjustment'] }, type: 'credit' });
    const payoutsOut = await sum({ source: 'payout', type: 'debit' });

    const agg = async (match) => (await Order.aggregate([
      { $match: match }, { $group: { _id: null, n: { $sum: '$total' } } },
    ]))[0]?.n || 0;
    const inTransit = await agg({
      paymentMethod: 'wallet',
      paymentStatus: 'paid',
      $or: [{ 'vendorPayout.paidAt': null }, { 'vendorPayout.paidAt': { $exists: false } }],
    });
    const codSettled = await agg({ paymentMethod: 'cod', 'vendorPayout.paidAt': { $ne: null } });

    const expected = externalIn - payoutsOut - inTransit + codSettled;
    check('6b. RECONCILIATION: no money is created or destroyed',
      totalBalances === expected,
      `Σ balances ${totalBalances} == in ${externalIn} − payouts ${payoutsOut} − inTransit ${inTransit} + COD ${codSettled} = ${expected}`);
    console.log(`      payments ${await sum({ source: 'shopping_payment', type: 'debit' })}, `
      + `earnings ${await sum({ source: 'shopping_earning', type: 'credit' })}, `
      + `commission ${await sum({ source: 'commission', type: 'credit' })} `
      + `(reversed ${await sum({ source: 'commission', type: 'debit' })}), `
      + `refund rows ${await sum({ source: 'refund', type: 'credit' })} credit / `
      + `${await sum({ source: 'refund', type: 'debit' })} debit`);
  }

  console.log('\n' + '='.repeat(66));
  console.log(' RESULT'.padEnd(52) + (failed === 0 ? 'ALL GREEN' : `${failed} FAILED`));
  console.log('='.repeat(66));
  rows.forEach((r) => console.log(` ${(r.ok ? 'PASS' : 'FAIL').padEnd(5)} ${r.name}`));
  console.log('='.repeat(66));
  console.log(`\n${passed} passed, ${failed} failed\n`);

  await mongoose.disconnect();
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('\nSweep aborted:', e.message);
  console.error(e.stack?.split('\n').slice(1, 4).join('\n'));
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
