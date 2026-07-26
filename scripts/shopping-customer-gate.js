/**
 * CUSTOMER PATH INTEGRITY GATE (shopping-Usama.md PROMPT 2, steps 8 & 10).
 *
 * Places one real multi-brand wallet order and then verifies EVERY claim in
 * step 8 with the actual numbers printed — the rupee-exact split, the
 * per-variant stock decrements, and both sides of the money movement — then
 * runs the step 10 negative cases.
 *
 * Uses the HTTP API for everything a customer does, and direct DB reads for
 * the assertions (an API that agrees with itself proves nothing).
 *
 * Run: DISABLE_RATE_LIMIT=true on the server, then
 *      API_URL=http://localhost:5000 node scripts/shopping-customer-gate.js
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
const Coupon = require('../src/modules/shopping/models/Coupon');
const Cart = require('../src/modules/shopping/models/Cart');
const User = require('../src/models/User');

const CUSTOMER = { email: 'shopper1.qa@metromatrix.pk', password: 'Shopper@123' };
const COUPON_CODE = 'COUGAR15';

let pass = 0;
let fail = 0;
const results = [];
const step = (id, name, ok, detail = '') => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
  results.push({ id, name, ok, detail });
  ok ? (pass += 1) : (fail += 1);
  return ok;
};
const auth = (t) => ({ headers: { Authorization: `Bearer ${t}` } });
const bal = async (owner, type) => {
  const w = await Wallet.findOne({ owner, ownerType: type });
  return w ? w.balance : 0;
};

(async () => {
  console.log(`\n=== CUSTOMER PATH INTEGRITY GATE against ${BASE} ===\n`);
  await mongoose.connect(process.env.MONGODB_URI);

  const lr = await api.post('/auth/login', CUSTOMER);
  const tok = lr.data?.accessToken;
  if (!tok) throw new Error(`login failed: ${JSON.stringify(lr.data).slice(0, 200)}`);
  const user = await User.findOne({ email: CUSTOMER.email });

  const brandsRes = await api.get('/shopping/brands?limit=10');
  const brands = brandsRes.data?.data || [];
  const cougar = await Brand.findOne({ slug: 'cougar' });
  const outf = await Brand.findOne({ slug: 'outfitters' });

  /* ── build a two-brand cart ── */
  await api.delete('/shopping/cart', auth(tok));
  const pickVariant = async (brandId, need) => {
    const list = await api.get(`/shopping/products?brandId=${brandId}&inStock=true&limit=40`);
    for (const p of list.data?.data || []) {
      const d = await api.get(`/shopping/products/${p.productId || p._id}`);
      const prod = d.data?.data;
      const v = (prod?.variants || []).find((x) => x.stockQuantity >= need + 1);
      if (v) return { productId: prod.productId || prod._id, variantId: v.variantId || v._id, unitPrice: v.price ?? prod.salePrice ?? prod.basePrice };
    }
    return null;
  };
  const QTY_A = 2;
  const QTY_B = 1;
  const a = await pickVariant(cougar._id, QTY_A);
  const b = await pickVariant(outf._id, QTY_B);
  if (!a || !b) throw new Error('could not find in-stock variants in both brands');

  // Record pre-order stock straight from the DB.
  const stockOf = async (productId, variantId) => {
    const p = await Product.findById(productId);
    return p.variants.id(variantId).stockQuantity;
  };
  const stockBeforeA = await stockOf(a.productId, a.variantId);
  const stockBeforeB = await stockOf(b.productId, b.variantId);

  await api.post('/shopping/cart/items', { productId: a.productId, variantId: a.variantId, quantity: QTY_A }, auth(tok));
  await api.post('/shopping/cart/items', { productId: b.productId, variantId: b.variantId, quantity: QTY_B }, auth(tok));

  // Apply a coupon so the discount-apportionment path is genuinely exercised.
  const couponBefore = await Coupon.findOne({ couponCode: COUPON_CODE });
  const couponRes = await api.post('/shopping/cart/coupon', { couponCode: COUPON_CODE }, auth(tok));
  const couponApplied = couponRes.status === 200 && couponRes.data?.data?.discount > 0;
  step('8.0', `coupon ${COUPON_CODE} applied so discount apportionment is exercised`, couponApplied,
    couponApplied ? `discount PKR ${couponRes.data.data.discount}` : 'proceeding without a coupon');

  const cartRes = await api.get('/shopping/cart', auth(tok));
  const cart = cartRes.data?.data;
  const cartTotal = cart?.total;

  const balBefore = await bal(user._id, 'User');
  const vendorBefore = { cougar: await bal(cougar.owner, 'Provider'), outf: await bal(outf.owner, 'Provider') };
  const platformBefore = (await WalletService.getPlatformWallet()).balance;

  console.log(`\n  cart total PKR ${cartTotal} | customer wallet PKR ${balBefore}`);
  console.log(`  stock before — A(Cougar) ${stockBeforeA}, B(Outfitters) ${stockBeforeB}\n`);

  /* ── place the order ── */
  const co = await api.post('/shopping/checkout', {
    paymentMethod: 'wallet',
    shippingAddress: { fullName: 'Hina Aslam', phone: '03005550011', addressLine1: 'House 1, Street 2', city: 'Lahore' },
  }, auth(tok));
  step('8.1', 'multi-brand wallet checkout succeeds', co.status === 201 || co.status === 200, `HTTP ${co.status}`);
  const groupId = co.data?.data?.groupId;
  const group = await OrderGroup.findById(groupId);
  const children = await Order.find({ orderGroup: group._id }).sort({ createdAt: 1 });

  /* ── 8a. one OrderGroup with the correct total ── */
  step('8.2', 'one OrderGroup created with the cart total',
    !!group && group.total === cartTotal, `group total ${group?.total} vs cart ${cartTotal}`);

  /* ── 8b. one Order per brand, summing to the exact rupee ── */
  const sumChildren = children.reduce((s, o) => s + o.total, 0);
  const sumSub = children.reduce((s, o) => s + o.subtotal, 0);
  const sumDisc = children.reduce((s, o) => s + o.discount, 0);
  const sumShip = children.reduce((s, o) => s + o.shippingFee, 0);
  console.log('\n  ── THE RUPEE-EXACT SPLIT ──');
  console.log(`  group:      subtotal ${group.subtotal}  discount ${group.discount}  shipping ${group.shippingFee}  TOTAL ${group.total}`);
  for (const o of children) {
    const bn = String(o.brandId) === String(cougar._id) ? 'Cougar    ' : 'Outfitters';
    console.log(`  ${bn}: subtotal ${o.subtotal}  discount ${o.discount}  shipping ${o.shippingFee}  total ${o.total}`);
  }
  console.log(`  children:   subtotal ${sumSub}  discount ${sumDisc}  shipping ${sumShip}  TOTAL ${sumChildren}\n`);

  step('8.3', 'exactly one Order per brand', children.length === 2, `${children.length} child orders`);
  step('8.4', 'child totals sum to the group total TO THE EXACT RUPEE',
    sumChildren === group.total, `${sumChildren} == ${group.total} (difference ${sumChildren - group.total})`);
  step('8.5', 'apportioned discount sums to the group discount exactly',
    sumDisc === group.discount, `${sumDisc} == ${group.discount}`);
  step('8.6', 'per-brand shipping sums to the group shipping exactly',
    sumShip === group.shippingFee, `${sumShip} == ${group.shippingFee}`);

  /* ── 8c. stock decremented by exactly the quantity ordered ── */
  const stockAfterA = await stockOf(a.productId, a.variantId);
  const stockAfterB = await stockOf(b.productId, b.variantId);
  step('8.7', 'variant A stock decremented by exactly the quantity ordered',
    stockBeforeA - stockAfterA === QTY_A, `${stockBeforeA} → ${stockAfterA} (ordered ${QTY_A})`);
  step('8.8', 'variant B stock decremented by exactly the quantity ordered',
    stockBeforeB - stockAfterB === QTY_B, `${stockBeforeB} → ${stockAfterB} (ordered ${QTY_B})`);

  /* ── 8d. money ── */
  const balAfter = await bal(user._id, 'User');
  step('8.9', 'customer wallet debited by EXACTLY the order total',
    balBefore - balAfter === group.total, `${balBefore} → ${balAfter} (debited ${balBefore - balAfter}, total ${group.total})`);

  const payTxn = await WalletTransaction.findOne({
    source: 'shopping_payment', 'relatedTo.kind': 'OrderGroup', 'relatedTo.id': group._id,
  });
  step('8.10', 'WalletTransaction source=shopping_payment with relatedTo the order',
    !!payTxn && payTxn.amount === group.total,
    payTxn ? `amount ${payTxn.amount}, relatedTo ${payTxn.relatedTo.kind}:${String(payTxn.relatedTo.id).slice(-6)}` : 'not found');

  // Vendor credit + commission happen at DELIVERY by design, so drive both
  // child orders there and then check the money landed correctly.
  const vLogin = async (email) => (await api.post('/auth/provider/login', { email, password: 'Vendor@123' })).data?.accessToken;
  const tokC = await vLogin('vendor.cougar@metromatrix.pk');
  const tokO = await vLogin('vendor.outfitters@metromatrix.pk');
  for (const o of children) {
    const t = String(o.brandId) === String(cougar._id) ? tokC : tokO;
    for (const s of ['confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered']) {
      const r = await api.patch(`/shopping/vendor/orders/${o._id}/status`, { status: s }, auth(t));
      if (r.status !== 200) throw new Error(`transition ${s} failed: ${JSON.stringify(r.data).slice(0, 150)}`);
    }
  }
  const vendorAfter = { cougar: await bal(cougar.owner, 'Provider'), outf: await bal(outf.owner, 'Provider') };
  const platformAfter = (await WalletService.getPlatformWallet()).balance;
  const fresh = await Order.find({ orderGroup: group._id });
  const expectNet = {};
  const expectComm = {};
  for (const o of fresh) {
    const k = String(o.brandId) === String(cougar._id) ? 'cougar' : 'outf';
    expectNet[k] = o.vendorPayout?.amount ?? 0;
    expectComm[k] = o.vendorPayout?.commission ?? 0;
  }
  const totalCommission = (expectComm.cougar || 0) + (expectComm.outf || 0);

  console.log('\n  ── MONEY MOVEMENT ──');
  console.log(`  customer:  ${balBefore} → ${balAfter}  (−${balBefore - balAfter})`);
  console.log(`  Cougar:    ${vendorBefore.cougar} → ${vendorAfter.cougar}  (+${vendorAfter.cougar - vendorBefore.cougar}, net ${expectNet.cougar}, commission ${expectComm.cougar})`);
  console.log(`  Outfitters:${vendorBefore.outf} → ${vendorAfter.outf}  (+${vendorAfter.outf - vendorBefore.outf}, net ${expectNet.outf}, commission ${expectComm.outf})`);
  console.log(`  Platform:  ${platformBefore} → ${platformAfter}  (+${platformAfter - platformBefore})\n`);

  step('8.11', 'each vendor credited its share minus commission',
    vendorAfter.cougar - vendorBefore.cougar === expectNet.cougar &&
    vendorAfter.outf - vendorBefore.outf === expectNet.outf,
    `cougar +${vendorAfter.cougar - vendorBefore.cougar}/${expectNet.cougar}, outfitters +${vendorAfter.outf - vendorBefore.outf}/${expectNet.outf}`);
  step('8.12', 'commission landed in the Platform ledger',
    platformAfter - platformBefore === totalCommission && totalCommission > 0,
    `+${platformAfter - platformBefore} (expected ${totalCommission})`);
  step('8.13', 'CONSERVATION: customer debit == vendor credits + commission',
    (balBefore - balAfter) === (expectNet.cougar + expectNet.outf + totalCommission),
    `${balBefore - balAfter} == ${expectNet.cougar} + ${expectNet.outf} + ${totalCommission}`);

  /* ── 8e. cart cleared, coupon consumed ── */
  const cartDoc = await Cart.findOne({ userId: user._id });
  step('8.14', 'cart cleared after checkout', (cartDoc?.items?.length || 0) === 0,
    `${cartDoc?.items?.length || 0} items remain`);
  if (couponApplied) {
    const couponAfter = await Coupon.findOne({ couponCode: COUPON_CODE });
    step('8.15', 'coupon usedCount incremented by exactly 1',
      couponAfter.usedCount === couponBefore.usedCount + 1,
      `${couponBefore.usedCount} → ${couponAfter.usedCount}`);
  }

  /* ─────── STEP 10 — NEGATIVE CASES ─────── */
  console.log('\n--- STEP 10: NEGATIVE CASES ---');

  // 10a. empty-cart checkout
  await api.delete('/shopping/cart', auth(tok));
  let r = await api.post('/shopping/checkout', {
    paymentMethod: 'wallet',
    shippingAddress: { fullName: 'X', phone: '03005550011', addressLine1: 'H1', city: 'Lahore' },
  }, auth(tok));
  step('10.1', 'empty-cart checkout rejected with a clear message',
    r.status >= 400 && r.status < 500 && /cart is empty/i.test(JSON.stringify(r.data)),
    `${r.status}: ${String(r.data?.error || r.data?.message).slice(0, 60)}`);

  // 10b. item that went out of stock AFTER being added to the cart
  const oos = await pickVariant(cougar._id, 1);
  await api.post('/shopping/cart/items', { productId: oos.productId, variantId: oos.variantId, quantity: 1 }, auth(tok));
  const keepStock = await stockOf(oos.productId, oos.variantId);
  await Product.updateOne({ _id: oos.productId, 'variants._id': oos.variantId },
    { $set: { 'variants.$.stockQuantity': 0 } });
  const balPreOos = await bal(user._id, 'User');
  r = await api.post('/shopping/checkout', {
    paymentMethod: 'wallet',
    shippingAddress: { fullName: 'X', phone: '03005550011', addressLine1: 'H1', city: 'Lahore' },
  }, auth(tok));
  const balPostOos = await bal(user._id, 'User');
  step('10.2', 'item that went out of stock after adding is rejected with a clear message',
    r.status >= 400 && r.status < 500 && /stock|available/i.test(JSON.stringify(r.data)),
    `${r.status}: ${String(r.data?.error || r.data?.message).slice(0, 70)}`);
  step('10.3', 'no wallet debit on the out-of-stock rejection',
    balPreOos === balPostOos, `${balPreOos} → ${balPostOos}`);
  await Product.updateOne({ _id: oos.productId, 'variants._id': oos.variantId },
    { $set: { 'variants.$.stockQuantity': keepStock } });
  await api.delete('/shopping/cart', auth(tok));

  // 10c. insufficient balance — blocks, NO partial debit, NO stock change
  const cheap = await pickVariant(outf._id, 1);
  await api.post('/shopping/cart/items', { productId: cheap.productId, variantId: cheap.variantId, quantity: 1 }, auth(tok));
  const stockPre = await stockOf(cheap.productId, cheap.variantId);
  const balPre = await bal(user._id, 'User');
  const drain = balPre - 1;
  if (drain > 0) {
    await WalletService.payWithSettle({
      payerType: 'User', payerId: user._id, amount: drain, source: 'admin_adjustment',
      relatedTo: { kind: 'OrderGroup', id: group._id }, description: 'gate: drain for insufficient-balance test',
    });
  }
  r = await api.post('/shopping/checkout', {
    paymentMethod: 'wallet',
    shippingAddress: { fullName: 'X', phone: '03005550011', addressLine1: 'H1', city: 'Lahore' },
  }, auth(tok));
  const balPost = await bal(user._id, 'User');
  const stockPost = await stockOf(cheap.productId, cheap.variantId);
  step('10.4', 'insufficient balance blocks with a clear message',
    r.status >= 400 && /insufficient/i.test(JSON.stringify(r.data)),
    `${r.status}: ${String(r.data?.error || r.data?.message).slice(0, 80)}`);
  step('10.5', 'NO partial debit on insufficient balance', balPost === 1, `balance ${balPre} → ${balPost}`);
  step('10.6', 'NO stock change on insufficient balance', stockPost === stockPre, `${stockPre} → ${stockPost}`);
  // restore the drained balance
  if (drain > 0) {
    await WalletService.refund({
      ownerType: 'User', ownerId: user._id, amount: drain, source: 'admin_adjustment',
      relatedTo: { kind: 'OrderGroup', id: group._id }, description: 'gate: restore after insufficient-balance test',
    });
  }
  await api.delete('/shopping/cart', auth(tok));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`);
  await mongoose.disconnect();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('\nGATE ABORTED:', e.message);
  console.error(e.stack);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
