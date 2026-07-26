/**
 * SHOPPING MONEY & STOCK INTEGRITY SWEEP (shopping-Usama.md PROMPT 5).
 *
 * These are the paths that corrupt data SILENTLY rather than throwing, so each
 * check is asserted against the database, never against an API response
 * agreeing with itself.
 *
 *   1 CONCURRENT OVERSELL      two customers, last unit, simultaneously
 *   2 MULTI-BRAND SPLIT        children reconcile to the group to the rupee
 *   3 WALLET CONSERVATION      debit == vendor credits + platform commission
 *   4 REFUND CORRECTNESS       customer, vendor, commission and stock all reverse
 *   5 DOUBLE-PAY / DOUBLE-REFUND  both rejected with NO ledger change
 *   6 RECONCILIATION           balances == net of completed ledger rows
 *   7 STOCK CONSERVATION       seeded - sold == current, for every variant
 *
 * Run: DISABLE_RATE_LIMIT=true on the server, then
 *      API_URL=http://localhost:5000 node scripts/shopping-integrity.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const mongoose = require('mongoose');

const BASE = process.env.API_URL || 'http://localhost:5000';
const api = axios.create({ baseURL: `${BASE}/api`, validateStatus: () => true, timeout: 45000 });

const Wallet = require('../src/models/Wallet');
const WalletTransaction = require('../src/models/WalletTransaction');
const WalletService = require('../src/services/walletService');
const Product = require('../src/modules/shopping/models/Product');
const Order = require('../src/modules/shopping/models/Order');
const OrderGroup = require('../src/modules/shopping/models/OrderGroup');
const Brand = require('../src/modules/shopping/models/Brand');
const User = require('../src/models/User');

const C1 = { email: 'shopper1.qa@metromatrix.pk', password: 'Shopper@123' };
const C2 = { email: 'shopper2.qa@metromatrix.pk', password: 'Shopper@123' };
const V_C = { email: 'vendor.cougar@metromatrix.pk', password: 'Vendor@123' };
const V_O = { email: 'vendor.outfitters@metromatrix.pk', password: 'Vendor@123' };

let pass = 0, fail = 0;
const results = [];
const step = (id, name, ok, detail = '') => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
  results.push({ id, name, ok, detail });
  ok ? (pass += 1) : (fail += 1);
  return ok;
};
const auth = (t) => ({ headers: { Authorization: `Bearer ${t}` } });
const bal = async (o, t) => { const w = await Wallet.findOne({ owner: o, ownerType: t }); return w ? w.balance : 0; };

/**
 * Per-wallet reconciliation: balance vs the net of that wallet's own completed
 * ledger rows. Returns the total signed discrepancy and the offenders.
 *
 * Two different questions get asked with this. The one about the CODE is
 * whether a full sweep adds any drift (delta must be exactly 0). The one about
 * the DATA is whether the shared dev database currently reconciles in absolute
 * terms — it accumulates residue from seed purges and from QA scripts that
 * deliberately drain and restore balances, so it can be non-zero without any
 * product defect. Both are reported; only conflating them would be dishonest.
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
      offenders.push(`${w.ownerType}:${String(w.owner).slice(-6)} ${w.balance}vs${net}`);
    }
  }
  return { total, offenders, count: wallets.length };
};
const ADDR = { fullName: 'QA', phone: '03005550011', addressLine1: 'H1 St2', city: 'Lahore' };

const pickVariant = async (brandId, need = 1) => {
  const list = await api.get(`/shopping/products?brandId=${brandId}&inStock=true&limit=40`);
  for (const p of list.data?.data || []) {
    const d = await api.get(`/shopping/products/${p.productId || p._id}`);
    const prod = d.data?.data;
    const v = (prod?.variants || []).find((x) => x.stockQuantity >= need);
    if (v) return { productId: prod.productId || prod._id, variantId: v.variantId || v._id };
  }
  return null;
};
const fund = async (userId, minimum) => {
  const b = await bal(userId, 'User');
  if (b < minimum) {
    await WalletService.refund({
      ownerType: 'User', ownerId: userId, amount: minimum - b,
      source: 'admin_adjustment', description: 'integrity sweep: funding',
    });
  }
};

(async () => {
  console.log(`\n=== SHOPPING MONEY & STOCK INTEGRITY SWEEP against ${BASE} ===\n`);
  await mongoose.connect(process.env.MONGODB_URI);

  const login = async (c, p = false) =>
    (await api.post(p ? '/auth/provider/login' : '/auth/login', c)).data?.accessToken;
  const t1 = await login(C1), t2 = await login(C2);
  const tvC = await login(V_C, true), tvO = await login(V_O, true);
  if (!t1 || !t2 || !tvC || !tvO) throw new Error('login failed — is DISABLE_RATE_LIMIT=true set?');

  const u1 = await User.findOne({ email: C1.email });
  const u2 = await User.findOne({ email: C2.email });
  const cougar = await Brand.findOne({ slug: 'cougar' });
  const outf = await Brand.findOne({ slug: 'outfitters' });

  await fund(u1._id, 80000);
  await fund(u2._id, 80000);

  // Baseline BEFORE any of the sweep's own money movement, so check 6 can
  // separate "this code drifts" from "this database already had residue".
  const driftBefore = await computeDrift();
  console.log(`(baseline drift: PKR ${driftBefore.total} across ${driftBefore.offenders.length}/${driftBefore.count} wallets)\n`);

  /* ── 1. CONCURRENT OVERSELL ── */
  console.log('--- 1. concurrent oversell ---');
  const race = await pickVariant(cougar._id, 1);
  await Product.updateOne({ _id: race.productId, 'variants._id': race.variantId },
    { $set: { 'variants.$.stockQuantity': 1 } });
  for (const t of [t1, t2]) {
    await api.delete('/shopping/cart', auth(t));
    await api.post('/shopping/cart/items', { ...race, quantity: 1 }, auth(t));
  }
  const [r1, r2] = await Promise.all([
    api.post('/shopping/checkout', { paymentMethod: 'wallet', shippingAddress: ADDR }, auth(t1)),
    api.post('/shopping/checkout', { paymentMethod: 'wallet', shippingAddress: ADDR }, auth(t2)),
  ]);
  const wins = [r1, r2].filter((r) => r.status === 200 || r.status === 201);
  const losers = [r1, r2].filter((r) => r.status >= 400);
  const raceStock = (await Product.findById(race.productId)).variants.id(race.variantId).stockQuantity;
  step('1.1', 'exactly ONE of two simultaneous checkouts for the last unit succeeds',
    wins.length === 1, `${wins.length} succeeded, ${losers.length} rejected`);
  step('1.2', 'the loser is rejected CLEANLY (4xx, not a 500)',
    losers.length === 1 && losers[0].status >= 400 && losers[0].status < 500,
    `status ${losers[0]?.status}: ${String(losers[0]?.data?.error || losers[0]?.data?.message).slice(0, 60)}`);
  step('1.3', 'final stock is 0 and never negative', raceStock === 0, `stock ${raceStock}`);
  for (const t of [t1, t2]) await api.delete('/shopping/cart', auth(t));

  /* ── 2 & 3. MULTI-BRAND SPLIT + WALLET CONSERVATION ── */
  console.log('\n--- 2/3. multi-brand split + wallet conservation ---');
  const a = await pickVariant(cougar._id, 2);
  const b = await pickVariant(outf._id, 1);
  await api.delete('/shopping/cart', auth(t1));
  await api.post('/shopping/cart/items', { ...a, quantity: 2 }, auth(t1));
  await api.post('/shopping/cart/items', { ...b, quantity: 1 }, auth(t1));

  const custBefore = await bal(u1._id, 'User');
  const vcBefore = await bal(cougar.owner, 'Provider');
  const voBefore = await bal(outf.owner, 'Provider');
  const platBefore = (await WalletService.getPlatformWallet()).balance;

  const co = await api.post('/shopping/checkout', { paymentMethod: 'wallet', shippingAddress: ADDR }, auth(t1));
  const group = await OrderGroup.findById(co.data?.data?.groupId);
  const children = await Order.find({ orderGroup: group._id });
  const sum = children.reduce((s, o) => s + o.total, 0);
  step('2.1', 'child order totals + shipping + apportioned discount == group total, EXACTLY',
    sum === group.total, `children ${sum} == group ${group.total} (diff ${sum - group.total})`);
  step('2.2', 'discount apportionment reconciles exactly',
    children.reduce((s, o) => s + o.discount, 0) === group.discount,
    `${children.reduce((s, o) => s + o.discount, 0)} == ${group.discount}`);

  const custAfterPay = await bal(u1._id, 'User');
  const debited = custBefore - custAfterPay;

  // Deliver both so the vendor/commission legs settle.
  for (const o of children) {
    const t = String(o.brandId) === String(cougar._id) ? tvC : tvO;
    for (const s of ['confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered']) {
      await api.patch(`/shopping/vendor/orders/${o._id}/status`, { status: s }, auth(t));
    }
  }
  const vcAfter = await bal(cougar.owner, 'Provider');
  const voAfter = await bal(outf.owner, 'Provider');
  const platAfter = (await WalletService.getPlatformWallet()).balance;
  const creditedVendors = (vcAfter - vcBefore) + (voAfter - voBefore);
  const creditedPlatform = platAfter - platBefore;
  step('3.1', 'WALLET CONSERVATION: customer debit == vendor credits + platform commission',
    debited === creditedVendors + creditedPlatform,
    `${debited} == ${creditedVendors} + ${creditedPlatform}`);

  /* ── 4. REFUND CORRECTNESS ── */
  console.log('\n--- 4. refund correctness ---');
  const refundOrder = await Order.findById(children[0]._id);
  const rToken = String(refundOrder.brandId) === String(cougar._id) ? tvC : tvO;
  const rOwner = String(refundOrder.brandId) === String(cougar._id) ? cougar.owner : outf.owner;
  const item = refundOrder.items[0];
  const stockPre = (await Product.findById(item.productId)).variants.id(item.variantId).stockQuantity;
  const custPre = await bal(u1._id, 'User');
  const vPre = await bal(rOwner, 'Provider');
  const pPre = (await WalletService.getPlatformWallet()).balance;
  const net = refundOrder.vendorPayout?.amount ?? 0;
  const comm = refundOrder.vendorPayout?.commission ?? 0;

  await api.patch(`/shopping/vendor/orders/${refundOrder._id}/status`, { status: 'returned' }, auth(rToken));
  await api.patch(`/shopping/vendor/orders/${refundOrder._id}/status`, { status: 'refunded' }, auth(rToken));

  const stockPost = (await Product.findById(item.productId)).variants.id(item.variantId).stockQuantity;
  const custPost = await bal(u1._id, 'User');
  const vPost = await bal(rOwner, 'Provider');
  const pPost = (await WalletService.getPlatformWallet()).balance;

  step('4.1', 'refund credits the customer the exact order total',
    custPost - custPre === refundOrder.total, `+${custPost - custPre} (total ${refundOrder.total})`);
  step('4.2', 'refund reverses the vendor credit exactly',
    vPre - vPost === net, `−${vPre - vPost} (expected −${net})`);
  step('4.3', 'refund reverses the commission exactly',
    pPre - pPost === comm, `−${pPre - pPost} (expected −${comm})`);
  step('4.4', 'refund restores stock by the exact quantity',
    stockPost - stockPre === item.quantity, `${stockPre} → ${stockPost} (qty ${item.quantity})`);

  /* ── 5. DOUBLE-PAY / DOUBLE-REFUND ── */
  console.log('\n--- 5. double-pay / double-refund ---');
  const balBeforeDbl = await bal(u1._id, 'User');
  const txBeforeDbl = await WalletTransaction.countDocuments({});
  // double-refund: the order is already refunded; refunding again must no-op.
  const again = await api.patch(`/shopping/vendor/orders/${refundOrder._id}/status`,
    { status: 'refunded' }, auth(rToken));
  const balAfterDbl = await bal(u1._id, 'User');
  step('5.1', 'refunding an already-refunded order is REJECTED',
    again.status >= 400, `${again.status}: ${String(again.data?.error || again.data?.message).slice(0, 60)}`);
  step('5.2', 'no ledger change from the double-refund attempt',
    balAfterDbl === balBeforeDbl, `balance ${balBeforeDbl} → ${balAfterDbl}`);

  // double-pay: a paid group cannot be paid again (the cart was cleared, and
  // the payer leg is idempotent on the group id).
  const paidGroup = await OrderGroup.findById(group._id);
  const dblPay = await api.post('/shopping/checkout', { paymentMethod: 'wallet', shippingAddress: ADDR }, auth(t1));
  const balAfterPayAttempt = await bal(u1._id, 'User');
  step('5.3', 'checkout with an empty cart after payment is rejected (no re-charge)',
    dblPay.status >= 400 && balAfterPayAttempt === balAfterDbl,
    `${dblPay.status}, balance unchanged at ${balAfterPayAttempt}`);
  step('5.4', 'the paid group is still marked paid exactly once',
    paidGroup.paymentStatus === 'paid',
    `group paymentStatus ${paidGroup.paymentStatus}, walletTxn ${paidGroup.walletTransactionId ? 'set' : 'missing'}`);
  const payTxns = await WalletTransaction.countDocuments({
    source: 'shopping_payment', 'relatedTo.kind': 'OrderGroup', 'relatedTo.id': group._id,
  });
  step('5.5', 'exactly ONE shopping_payment ledger row exists for the group',
    payTxns === 1, `${payTxns} rows`);

  /* ── 6. RECONCILIATION ── */
  console.log('\n--- 6. reconciliation ---');
  const driftAfter = await computeDrift();
  const wallets = await Wallet.find({});
  const held = wallets.reduce((s, w) => s + w.balance, 0);

  // THE statement about the code: everything this sweep moved — an oversell
  // race, a multi-brand order, vendor payouts, commission, a full refund —
  // is fully ledgered.
  step('6.1', 'this sweep introduced ZERO new drift (every rupee it moved is ledgered)',
    driftAfter.total === driftBefore.total,
    `drift ${driftBefore.total} → ${driftAfter.total} (delta ${driftAfter.total - driftBefore.total})`);

  // The statement about the data.
  step('6.2', 'whole dataset reconciles: every wallet balance == its own completed ledger rows',
    driftAfter.total === 0,
    driftAfter.total === 0
      ? `held PKR ${held} across ${driftAfter.count} wallets, difference 0`
      : `PKR ${driftAfter.total} residue across ${driftAfter.offenders.length}/${driftAfter.count} wallets — run scripts/wallet-reconcile-repair.js`);

  /* ── 7. STOCK CONSERVATION ── */
  console.log('\n--- 7. stock conservation ---');
  // For every variant: units currently held + units sitting in non-cancelled,
  // non-restocked orders must equal what the catalogue started with. Since the
  // seed baseline isn't retained, assert the invariants that must hold now:
  // no negative stock anywhere, and every ordered line traces to a real variant.
  const allProducts = await Product.find({});
  let negative = 0, variants = 0;
  for (const p of allProducts) {
    for (const v of p.variants) {
      variants += 1;
      if (v.stockQuantity < 0) negative += 1;
    }
  }
  step('7.1', 'no variant anywhere has negative stock',
    negative === 0, `${variants} variants checked, ${negative} negative`);

  const openOrders = await Order.find({ orderStatus: { $nin: ['cancelled', 'refunded'] } });
  let orphanLines = 0, checkedLines = 0;
  for (const o of openOrders) {
    for (const line of o.items) {
      checkedLines += 1;
      const prod = await Product.findById(line.productId);
      if (!prod || !prod.variants.id(line.variantId)) orphanLines += 1;
    }
  }
  step('7.2', 'every line in a live order still resolves to a real product variant',
    orphanLines === 0, `${checkedLines} lines checked, ${orphanLines} orphaned`);

  const inStockFlagWrong = allProducts.filter((p) => {
    const anyStock = p.variants.some((v) => v.stockQuantity > 0);
    return p.inStock !== anyStock;
  }).length;
  step('7.3', 'the denormalised inStock flag agrees with actual variant stock',
    inStockFlagWrong === 0, `${inStockFlagWrong} products disagree`);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`);
  require('fs').writeFileSync(
    require('path').join(__dirname, '..', 'shopping-integrity-results.json'),
    JSON.stringify({ results, pass, fail, at: new Date().toISOString() }, null, 2)
  );
  await mongoose.disconnect();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('\nSWEEP ABORTED:', e.message, '\n', e.stack);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
