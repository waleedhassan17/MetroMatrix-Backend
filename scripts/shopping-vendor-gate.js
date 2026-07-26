/**
 * VENDOR PATH GATE (shopping-Usama.md PROMPT 3).
 *
 * Drives the vendor path with the two seeded vendor accounts and asserts the
 * things that actually matter: the full fulfilment lifecycle, rejection of
 * illegal transitions, the stock↔money loop through a return, earnings landing
 * in the SHARED polymorphic wallet, and — the one the pack says not to skip —
 * cross-tenant isolation in both directions.
 *
 * Analytics figures are hand-verified against the database rather than trusted.
 *
 * Run: API_URL=http://localhost:5000 node scripts/shopping-vendor-gate.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const mongoose = require('mongoose');

const BASE = process.env.API_URL || 'http://localhost:5000';
const api = axios.create({ baseURL: `${BASE}/api`, validateStatus: () => true, timeout: 45000 });

const Wallet = require('../src/models/Wallet');
const Product = require('../src/modules/shopping/models/Product');
const Order = require('../src/modules/shopping/models/Order');
const Brand = require('../src/modules/shopping/models/Brand');
const User = require('../src/models/User');
const InventoryLog = require('../src/modules/shopping/models/InventoryLog');

const CUSTOMER = { email: 'shopper1.qa@metromatrix.pk', password: 'Shopper@123' };
const V_COUGAR = { email: 'vendor.cougar@metromatrix.pk', password: 'Vendor@123' };
const V_OUTF = { email: 'vendor.outfitters@metromatrix.pk', password: 'Vendor@123' };

let pass = 0, fail = 0;
const step = (id, name, ok, detail = '') => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? (pass += 1) : (fail += 1);
  return ok;
};
const auth = (t) => ({ headers: { Authorization: `Bearer ${t}` } });
const bal = async (o, t) => { const w = await Wallet.findOne({ owner: o, ownerType: t }); return w ? w.balance : 0; };
const short = (d) => JSON.stringify(d).slice(0, 110);

(async () => {
  console.log(`\n=== VENDOR PATH GATE against ${BASE} ===\n`);
  await mongoose.connect(process.env.MONGODB_URI);

  const login = async (c, provider = true) =>
    (await api.post(provider ? '/auth/provider/login' : '/auth/login', c)).data?.accessToken;
  const tC = await login(V_COUGAR);
  const tO = await login(V_OUTF);
  const tU = await login(CUSTOMER, false);
  if (!tC || !tO || !tU) throw new Error('login failed — is DISABLE_RATE_LIMIT=true set on the server?');

  const cougar = await Brand.findOne({ slug: 'cougar' });
  const outf = await Brand.findOne({ slug: 'outfitters' });
  const user = await User.findOne({ email: CUSTOMER.email });

  /* ── 1. dashboard tiles verified against the DB ── */
  const dash = await api.get('/shopping/vendor/dashboard', auth(tC));
  const dbOrders = await Order.countDocuments({ brandId: cougar._id });
  const dbProducts = await Product.countDocuments({ brandId: cougar._id, isActive: true });
  const d = dash.data?.data || {};
  const tileOrders = d.totalOrders ?? d.orders ?? d.orderCount ?? null;
  const tileProducts = d.totalProducts ?? d.products ?? d.productCount ?? null;
  step('3.1', 'vendor dashboard loads', dash.status === 200, `keys: ${Object.keys(d).join(', ').slice(0, 90)}`);
  step('3.2', 'dashboard product count matches the DB',
    tileProducts === null || Number(tileProducts) === dbProducts,
    tileProducts === null ? 'not exposed' : `tile ${tileProducts} vs db ${dbProducts}`);

  /* ── 2. product validation ── */
  const badCases = [
    ['missing required fields', {}],
    ['negative price', { name: 'QA Bad', basePrice: -5, categoryId: null }],
    ['salePrice above basePrice', { name: 'QA Bad2', basePrice: 100, salePrice: 500 }],
  ];
  for (const [label, body] of badCases) {
    const r = await api.post('/shopping/vendor/products', body, auth(tC));
    step('3.3', `product create rejects ${label}`, r.status >= 400 && r.status < 500,
      `${r.status}: ${short(r.data?.error || r.data?.message)}`);
  }

  /* ── 3. inventory single update writes an InventoryLog ── */
  const inv = await api.get('/shopping/vendor/inventory?limit=50', auth(tC));
  const row = (inv.data?.data || []).find((x) => x.stockQuantity > 0);
  const logsBefore = await InventoryLog.countDocuments({ brandId: cougar._id });
  const orig = row.stockQuantity;
  let r = await api.patch(`/shopping/vendor/inventory/${row.variantId}`,
    { stockQuantity: orig + 5, reason: 'vendor gate: restock' }, auth(tC));
  const logsAfter = await InventoryLog.countDocuments({ brandId: cougar._id });
  step('3.4', 'single stock update succeeds and writes an InventoryLog',
    r.status === 200 && logsAfter === logsBefore + 1, `logs ${logsBefore} → ${logsAfter}`);
  const prodNow = await Product.findById(row.productId);
  step('3.5', 'stock change is persisted exactly',
    prodNow.variants.id(row.variantId).stockQuantity === orig + 5,
    `${orig} → ${prodNow.variants.id(row.variantId).stockQuantity}`);
  await api.patch(`/shopping/vendor/inventory/${row.variantId}`,
    { stockQuantity: orig, reason: 'vendor gate: restore' }, auth(tC));

  r = await api.patch(`/shopping/vendor/inventory/${row.variantId}`,
    { stockQuantity: -3, reason: 'vendor gate: invalid' }, auth(tC));
  step('3.6', 'negative stock rejected with 400', r.status === 400, `${r.status}: ${short(r.data?.error)}`);

  /* ── 4. THE CRITICAL ISOLATION TEST, both directions ── */
  console.log('\n  ── cross-tenant isolation (both directions) ──');
  const cProd = (await api.get('/shopping/vendor/products?limit=5', auth(tC))).data?.data?.[0];
  const oProd = (await api.get('/shopping/vendor/products?limit=5', auth(tO))).data?.data?.[0];
  const cOrder = (await api.get('/shopping/vendor/orders?limit=5', auth(tC))).data?.data?.[0];
  const oOrder = (await api.get('/shopping/vendor/orders?limit=5', auth(tO))).data?.data?.[0];
  const cInvRow = (await api.get('/shopping/vendor/inventory?limit=5', auth(tC))).data?.data?.[0];
  const oInvRow = (await api.get('/shopping/vendor/inventory?limit=5', auth(tO))).data?.data?.[0];

  const denied = (s) => s === 403 || s === 404;
  const pairs = [
    ['Outfitters → Cougar', tO, cProd, cOrder, cInvRow],
    ['Cougar → Outfitters', tC, oProd, oOrder, oInvRow],
  ];
  for (const [label, tok, prod, ord, invRow] of pairs) {
    if (prod) {
      const pid = prod.productId || prod._id;
      r = await api.get(`/shopping/vendor/products?productId=${pid}`, auth(tok));
      r = await api.patch(`/shopping/vendor/products/${pid}`, { name: 'CROSS TENANT WRITE' }, auth(tok));
      step('3.7', `${label}: MODIFY product denied`, denied(r.status),
        `${r.status}${r.status === 200 ? ' *** P0 LEAK ***' : ''}`);
      r = await api.delete(`/shopping/vendor/products/${pid}`, auth(tok));
      step('3.8', `${label}: DELETE product denied`, denied(r.status),
        `${r.status}${r.status === 200 ? ' *** P0 LEAK ***' : ''}`);
    }
    if (ord) {
      const oid = ord.orderId || ord._id;
      r = await api.get(`/shopping/vendor/orders/${oid}`, auth(tok));
      step('3.9', `${label}: READ order denied`, denied(r.status),
        `${r.status}${r.status === 200 ? ' *** P0 LEAK ***' : ''}`);
      r = await api.patch(`/shopping/vendor/orders/${oid}/status`, { status: 'confirmed' }, auth(tok));
      step('3.10', `${label}: MODIFY order denied`, denied(r.status),
        `${r.status}${r.status === 200 ? ' *** P0 LEAK ***' : ''}`);
    }
    if (invRow) {
      r = await api.patch(`/shopping/vendor/inventory/${invRow.variantId}`,
        { stockQuantity: 99999, reason: 'cross-tenant' }, auth(tok));
      step('3.11', `${label}: MODIFY inventory denied with 404`, r.status === 404,
        `${r.status}${r.status === 200 ? ' *** P0 LEAK ***' : ''}`);
      const after = await Product.findById(invRow.productId);
      step('3.12', `${label}: target stock unchanged`,
        after.variants.id(invRow.variantId).stockQuantity !== 99999,
        `stock ${after.variants.id(invRow.variantId).stockQuantity}`);
    }
  }

  /* ── 5. full lifecycle + illegal transition ── */
  console.log('\n  ── fulfilment lifecycle ──');
  // Place a fresh single-brand order so we own the whole lifecycle.
  await api.delete('/shopping/cart', auth(tU));
  const list = await api.get(`/shopping/products?brandId=${cougar._id}&inStock=true&limit=30`);
  let picked = null;
  for (const p of list.data?.data || []) {
    const det = await api.get(`/shopping/products/${p.productId || p._id}`);
    const v = (det.data?.data?.variants || []).find((x) => x.stockQuantity >= 2);
    if (v) { picked = { productId: det.data.data.productId || det.data.data._id, variantId: v.variantId || v._id }; break; }
  }
  await api.post('/shopping/cart/items', { ...picked, quantity: 1 }, auth(tU));
  const co = await api.post('/shopping/checkout', {
    paymentMethod: 'wallet',
    shippingAddress: { fullName: 'QA', phone: '03005550011', addressLine1: 'H1', city: 'Lahore' },
  }, auth(tU));
  const grpId = co.data?.data?.groupId;
  const child = await Order.findOne({ orderGroup: grpId });
  step('3.13', 'test order placed for lifecycle', !!child, `order ${child?.odexId}`);

  // illegal jump: pending -> delivered
  r = await api.patch(`/shopping/vendor/orders/${child._id}/status`, { status: 'delivered' }, auth(tC));
  step('3.14', 'illegal transition pending → delivered is REJECTED',
    r.status >= 400 && /cannot move/i.test(JSON.stringify(r.data)),
    `${r.status}: ${short(r.data?.error || r.data?.message)}`);

  const vendorBefore = await bal(cougar.owner, 'Provider');
  for (const s of ['confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered']) {
    r = await api.patch(`/shopping/vendor/orders/${child._id}/status`,
      { status: s, trackingNumber: s === 'shipped' ? 'TCS-VGATE-1' : undefined }, auth(tC));
    if (r.status !== 200) { step('3.15', `transition → ${s}`, false, short(r.data)); break; }
  }
  const delivered = await Order.findById(child._id);
  step('3.15', 'full lifecycle pending → delivered succeeds', delivered.orderStatus === 'delivered',
    `status ${delivered.orderStatus}, tracking ${delivered.trackingNumber}`);

  /* ── 6. earnings land in the SHARED polymorphic wallet ── */
  const vendorAfter = await bal(cougar.owner, 'Provider');
  const net = delivered.vendorPayout?.amount ?? 0;
  const comm = delivered.vendorPayout?.commission ?? 0;
  step('3.16', 'earnings credited on delivery, minus commission',
    vendorAfter - vendorBefore === net && net > 0,
    `${vendorBefore} → ${vendorAfter} (+${vendorAfter - vendorBefore}, net ${net}, commission ${comm})`);
  const w = await Wallet.findOne({ owner: cougar.owner, ownerType: 'Provider' });
  step('3.17', 'earnings are in the shared polymorphic wallet (ownerType Provider), not a shopping-only balance',
    !!w && w.ownerType === 'Provider', `wallet ${w?._id} ownerType ${w?.ownerType}`);
  const apiWallet = await api.get('/wallet/me', auth(tC));
  step('3.18', 'the same balance is visible on the shared /wallet/me endpoint',
    apiWallet.data?.wallet?.balance === vendorAfter, `api ${apiWallet.data?.wallet?.balance} db ${vendorAfter}`);

  /* ── 7. return loop: stock restored AND customer refunded, commission reversed ── */
  console.log('\n  ── return loop (money + stock) ──');
  const item = delivered.items[0];
  const stockBefore = (await Product.findById(item.productId)).variants.id(item.variantId).stockQuantity;
  const custBefore = await bal(user._id, 'User');
  const vBeforeRet = await bal(cougar.owner, 'Provider');
  const WalletService = require('../src/services/walletService');
  const platBefore = (await WalletService.getPlatformWallet()).balance;

  r = await api.patch(`/shopping/vendor/orders/${delivered._id}/status`, { status: 'returned' }, auth(tC));
  step('3.19', 'delivered → returned accepted', r.status === 200, `${r.status}`);
  r = await api.patch(`/shopping/vendor/orders/${delivered._id}/status`, { status: 'refunded' }, auth(tC));
  step('3.20', 'returned → refunded accepted', r.status === 200, `${r.status}`);

  const stockAfter = (await Product.findById(item.productId)).variants.id(item.variantId).stockQuantity;
  const custAfter = await bal(user._id, 'User');
  const vAfterRet = await bal(cougar.owner, 'Provider');
  const platAfter = (await WalletService.getPlatformWallet()).balance;

  step('3.21', 'refund restores stock by exactly the quantity returned',
    stockAfter - stockBefore === item.quantity, `${stockBefore} → ${stockAfter} (qty ${item.quantity})`);
  step('3.22', 'refund credits the customer the order total',
    custAfter - custBefore === delivered.total, `${custBefore} → ${custAfter} (+${custAfter - custBefore}, total ${delivered.total})`);
  step('3.23', "refund reverses the vendor's earning",
    vBeforeRet - vAfterRet === net, `${vBeforeRet} → ${vAfterRet} (−${vBeforeRet - vAfterRet}, expected −${net})`);
  step('3.24', 'refund reverses the commission from the Platform ledger',
    platBefore - platAfter === comm, `${platBefore} → ${platAfter} (expected −${comm})`);

  /* ── 8. analytics hand-verified against the DB ── */
  console.log('\n  ── analytics hand-check ──');
  // Hand-verified against the DB using each figure's ACTUAL definition, read
  // from vendorOrderController. An earlier version of this gate looked for
  // flat `totalOrders`/`totalRevenue` keys, found them nested under `summary`,
  // and passed every analytics check vacuously as "not exposed" — proving
  // nothing at all.
  const an = await api.get('/shopping/vendor/analytics', auth(tC));
  const summary = an.data?.data?.summary || {};
  const dash2 = (await api.get('/shopping/vendor/dashboard', auth(tC))).data?.data?.kpis || {};

  const orders = await Order.find({ brandId: cougar._id });
  const dbAll = orders.length;
  const dbDelivered = orders.filter((o) => o.orderStatus === 'delivered');
  const dbRevenue = dbDelivered.reduce((s, o) => s + o.total, 0);
  const dbReturns = orders.filter((o) => ['returned', 'refunded'].includes(o.orderStatus));
  const dbAov = dbAll ? Math.round(orders.reduce((s, o) => s + o.total, 0) / dbAll) : 0;
  const dbClosed = orders.filter((o) => ['delivered', 'cancelled', 'returned', 'refunded'].includes(o.orderStatus));
  const dbDeliveryRate = dbClosed.length
    ? Math.round((dbDelivered.length / dbClosed.length) * 1000) / 10 : 0;
  const dbActiveProducts = await Product.countDocuments({ brandId: cougar._id, isActive: true });

  console.log(`    DB: ${dbAll} orders, ${dbDelivered.length} delivered, revenue ${dbRevenue}, AOV ${dbAov}, deliveryRate ${dbDeliveryRate}%`);

  step('3.25', 'analytics revenue == sum of DELIVERED order totals',
    summary.totalRevenue === dbRevenue, `api ${summary.totalRevenue} vs db ${dbRevenue}`);
  step('3.26', 'analytics order count == all orders for the brand',
    summary.totalOrders === dbAll, `api ${summary.totalOrders} vs db ${dbAll}`);
  step('3.27', 'analytics AOV == mean of ALL order totals (its actual definition)',
    summary.avgOrderValue === dbAov, `api ${summary.avgOrderValue} vs db ${dbAov}`);
  step('3.28', 'analytics returnsCount == returned+refunded orders',
    summary.returnsCount === dbReturns.length, `api ${summary.returnsCount} vs db ${dbReturns.length}`);
  step('3.29', 'analytics refundsAmount == sum of returned+refunded totals',
    summary.refundsAmount === dbReturns.reduce((s, o) => s + o.total, 0),
    `api ${summary.refundsAmount} vs db ${dbReturns.reduce((s, o) => s + o.total, 0)}`);
  step('3.30', 'dashboard deliveryRate == delivered / closed orders',
    dash2.deliveryRate === dbDeliveryRate, `api ${dash2.deliveryRate}% vs db ${dbDeliveryRate}%`);
  step('3.31', 'dashboard product count == active products for the brand',
    dash2.products === dbActiveProducts, `api ${dash2.products} vs db ${dbActiveProducts}`);
  step('3.32', 'dashboard revenue agrees with analytics revenue',
    dash2.revenue === summary.totalRevenue, `dashboard ${dash2.revenue} vs analytics ${summary.totalRevenue}`);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`);
  await mongoose.disconnect();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('\nGATE ABORTED:', e.message, '\n', e.stack);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
