/**
 * SHOPPING TRIAGE PROBE (shopping-Usama.md PROMPT 1, STEP 2).
 *
 * Walks the three shopping happy paths against a live server with the
 * Cougar + Outfitters seed and RECORDS where each one breaks. It does not
 * fix anything and it does not stop at the first failure — the point is a
 * complete defect list in one run, not a single stack trace.
 *
 * Run: API_URL=http://localhost:5000 node scripts/shopping-triage-probe.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');

const BASE = process.env.API_URL || 'http://localhost:5000';
const api = axios.create({ baseURL: `${BASE}/api`, validateStatus: () => true, timeout: 45000 });

const CUSTOMER = { email: 'shopper1.qa@metromatrix.pk', password: 'Shopper@123' };
const VENDOR_COUGAR = { email: 'vendor.cougar@metromatrix.pk', password: 'Vendor@123' };
const VENDOR_OUTFITTERS = { email: 'vendor.outfitters@metromatrix.pk', password: 'Vendor@123' };
const ADMIN = { email: 'waleedhassansfd@gmail.com', password: 'Waleed@104' };

const findings = [];
let ok = 0;
let bad = 0;
const rec = (role, step, pass, detail = '') => {
  console.log(`[${pass ? ' OK ' : 'FAIL'}] ${role.padEnd(8)} ${step}${detail ? ` — ${detail}` : ''}`);
  findings.push({ role, step, pass, detail });
  pass ? (ok += 1) : (bad += 1);
  return pass;
};
const auth = (t) => ({ headers: { Authorization: `Bearer ${t}` } });
const short = (d) => JSON.stringify(d).slice(0, 130);

/**
 * Auth endpoints are rate limited (10 per window). A probe that logs in four
 * times per run exhausts that quickly, and a 429 looks identical to bad
 * credentials if you only check for a token — which is exactly how an earlier
 * run reported "login failed" for accounts that were perfectly fine. Back off
 * and retry, and say WHY when it still fails.
 */
const login = async (creds, kind) => {
  const path =
    kind === 'admin' ? '/admin/auth/login' : kind === 'provider' ? '/auth/provider/login' : '/auth/login';
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const r = await api.post(path, creds);
    const token = r.data?.accessToken || r.data?.token;
    if (token) return token;
    if (r.status === 429) {
      const waitMs = 20000 * attempt;
      console.log(`      (rate limited on ${path}; waiting ${waitMs / 1000}s — attempt ${attempt}/4)`);
      await new Promise((res) => setTimeout(res, waitMs));
      continue;
    }
    console.log(`      login failed for ${creds.email}: HTTP ${r.status} ${short(r.data)}`);
    return null;
  }
  console.log(`      login for ${creds.email} still rate limited after retries`);
  return null;
};

(async () => {
  console.log(`\n=== SHOPPING TRIAGE PROBE against ${BASE} ===\n`);

  /* ─────────────── CUSTOMER ─────────────── */
  console.log('--- CUSTOMER PATH ---');
  const cust = await login(CUSTOMER, 'user');
  if (!rec('customer', 'login', !!cust)) return finish();

  let r = await api.get('/shopping/brands?limit=20');
  const brands = r.data?.data || [];
  rec('customer', 'brand list shows both brands', r.status === 200 && brands.length >= 2,
    brands.map((b) => b.slug).join(', '));
  const cougar = brands.find((b) => b.slug === 'cougar');
  const outf = brands.find((b) => b.slug === 'outfitters');

  if (cougar) {
    r = await api.get(`/shopping/brands/slug/${cougar.slug}`);
    rec('customer', 'brand store by slug', r.status === 200, `status ${r.status}`);
    r = await api.get(`/shopping/brands/${cougar._id || cougar.id}/categories`);
    rec('customer', 'brand categories', r.status === 200, `${(r.data?.data || []).length} categories`);
  }

  // Filters and sorts must actually change the result set.
  const bid = cougar?._id || cougar?.id;
  const base = await api.get(`/shopping/products?brandId=${bid}&limit=50`);
  const baseIds = (base.data?.data || []).map((p) => p.productId || p._id).join(',');
  rec('customer', 'product list loads', base.status === 200, `${(base.data?.data || []).length} products`);

  // NOTE: the query param is `sortBy` (not `sort`) and `isFeatured` (not
  // `featured`) — these are the names productApi.ts actually sends. An
  // earlier version of this probe used the wrong names and reported six
  // working sorts as broken no-ops.
  for (const [label, qs] of [
    ['sort price_asc', `brandId=${bid}&sortBy=price_asc&limit=50`],
    ['sort price_desc', `brandId=${bid}&sortBy=price_desc&limit=50`],
    ['sort newest', `brandId=${bid}&sortBy=newest&limit=50`],
    ['sort rating', `brandId=${bid}&sortBy=rating&limit=50`],
    ['sort popular', `brandId=${bid}&sortBy=popular&limit=50`],
    ['filter inStock', `brandId=${bid}&inStock=true&limit=50`],
    ['filter featured', `brandId=${bid}&isFeatured=true&limit=50`],
    ['filter price range', `brandId=${bid}&minPrice=1000&maxPrice=3000&limit=50`],
  ]) {
    const res = await api.get(`/shopping/products?${qs}`);
    const ids = (res.data?.data || []).map((p) => p.productId || p._id).join(',');
    const changed = res.status === 200 && ids !== baseIds;
    const nonEmpty = (res.data?.data || []).length > 0;
    rec('customer', `${label} changes results`, res.status === 200 && (changed || !nonEmpty),
      changed ? 'different order/set' : nonEmpty ? 'IDENTICAL to unsorted — likely a no-op' : 'empty result');
  }

  r = await api.get('/shopping/products?search=shirt&limit=5');
  rec('customer', 'product search', r.status === 200, `${(r.data?.data || []).length} hits`);

  // Product detail
  const firstProduct = (base.data?.data || [])[0];
  if (firstProduct) {
    r = await api.get(`/shopping/products/${firstProduct.productId || firstProduct._id}`);
    const p = r.data?.data;
    rec('customer', 'product detail w/ variants', r.status === 200 && Array.isArray(p?.variants),
      `${p?.variants?.length || 0} variants`);
    r = await api.get(`/shopping/products/${firstProduct.productId || firstProduct._id}/reviews`);
    rec('customer', 'product reviews', r.status === 200, `${(r.data?.data || []).length} reviews`);
  }

  // Cart
  await api.delete('/shopping/cart', auth(cust));
  const pick = async (brandId, need = 1) => {
    const res = await api.get(`/shopping/products?brandId=${brandId}&inStock=true&limit=50`);
    for (const p of res.data?.data || []) {
      const full = await api.get(`/shopping/products/${p.productId || p._id}`);
      const v = (full.data?.data?.variants || []).find((x) => x.stockQuantity >= need);
      if (v) return { productId: full.data.data.productId || full.data.data._id, variantId: v.variantId || v._id };
    }
    return null;
  };
  const pc = await pick(bid);
  const po = await pick(outf?._id || outf?.id);
  if (pc) {
    r = await api.post('/shopping/cart/items', { ...pc, quantity: 1 }, auth(cust));
    rec('customer', 'add brand-A item to cart', r.status === 200, `status ${r.status}`);
    r = await api.post('/shopping/cart/items', { ...pc, quantity: 1 }, auth(cust));
    const cd = r.data?.data;
    const line = (cd?.items || []).find((i) => String(i.variantId) === String(pc.variantId));
    rec('customer', 'same variant increments line (not duplicate)', line?.quantity === 2,
      `qty=${line?.quantity}, lines=${cd?.items?.length}`);
  }
  if (po) {
    r = await api.post('/shopping/cart/items', { ...po, quantity: 1 }, auth(cust));
    rec('customer', 'add brand-B item to cart', r.status === 200, `status ${r.status}`);
  }
  r = await api.get('/shopping/cart', auth(cust));
  const cart = r.data?.data;
  const cartBrands = new Set((cart?.items || []).map((i) => String(i.brandId?._id || i.brandId)));
  rec('customer', 'cart holds BOTH brands', cartBrands.size === 2, `${cartBrands.size} brands, total ${cart?.total}`);

  // Coupons — each rejection needs a SPECIFIC reason
  for (const [code, expect] of [
    ['COUGAR15', 'valid'],
    ['COUGAREXPIRED', 'expired'],
    ['DOESNOTEXIST', 'unknown'],
  ]) {
    r = await api.post('/shopping/cart/coupon', { couponCode: code }, auth(cust));
    const msg = String(r.data?.error || r.data?.message || '');
    if (expect === 'valid') {
      rec('customer', `coupon ${code} applies`, r.status === 200 && r.data?.data?.discount > 0,
        r.status === 200 ? `discount ${r.data?.data?.discount}` : short(r.data));
      await api.delete('/shopping/cart/coupon', auth(cust));
    } else {
      const specific = r.status >= 400 && msg.length > 0 && !/^invalid coupon code$/i.test(msg);
      rec('customer', `coupon ${code} rejected with a SPECIFIC reason`, specific, `${r.status}: ${msg.slice(0, 70)}`);
    }
  }

  // Addresses
  r = await api.get('/shopping/addresses', auth(cust));
  rec('customer', 'addresses list', r.status === 200, `${(r.data?.data || []).length} saved`);

  // Checkout (integrity numbers verified separately by shopping-integrity.js)
  r = await api.post('/shopping/checkout', {
    paymentMethod: 'wallet',
    shippingAddress: { fullName: 'QA Probe', phone: '03005550011', addressLine1: 'H1 St2', city: 'Lahore' },
  }, auth(cust));
  const grp = r.data?.data;
  rec('customer', 'wallet checkout (multi-brand)', r.status === 201 || r.status === 200,
    `status ${r.status} ${grp ? `group ${grp.groupId}, total ${grp.total}, ${grp.orders?.length} children` : short(r.data)}`);

  r = await api.get('/shopping/orders', auth(cust));
  rec('customer', 'my orders', r.status === 200, `${(r.data?.data || []).length} orders`);
  const anyOrder = (r.data?.data || [])[0];
  const childId = anyOrder?.orders?.[0]?.orderId || anyOrder?.orderId || anyOrder?._id;
  if (childId) {
    r = await api.get(`/shopping/orders/${childId}`, auth(cust));
    rec('customer', 'order detail', r.status === 200, `status ${r.status}`);
    r = await api.get(`/shopping/orders/${childId}/tracking`, auth(cust));
    rec('customer', 'order tracking', r.status === 200, `status ${r.status}`);
  }

  // Negative: empty-cart checkout
  await api.delete('/shopping/cart', auth(cust));
  r = await api.post('/shopping/checkout', {
    paymentMethod: 'wallet',
    shippingAddress: { fullName: 'QA', phone: '03005550011', addressLine1: 'H1', city: 'Lahore' },
  }, auth(cust));
  rec('customer', 'empty-cart checkout fails gracefully', r.status >= 400 && r.status < 500,
    `${r.status}: ${String(r.data?.error || r.data?.message).slice(0, 60)}`);

  r = await api.get('/shopping/wishlist', auth(cust));
  rec('customer', 'wishlist', r.status === 200, `status ${r.status}`);

  /* ─────────────── VENDOR ─────────────── */
  console.log('\n--- VENDOR PATH ---');
  const vc = await login(VENDOR_COUGAR, 'provider');
  const vo = await login(VENDOR_OUTFITTERS, 'provider');
  rec('vendor', 'both vendors log in', !!vc && !!vo);
  if (!vc || !vo) return finish();

  for (const [name, ep] of [
    ['dashboard', '/shopping/vendor/dashboard'],
    ['brand profile', '/shopping/vendor/brand'],
    ['products', '/shopping/vendor/products'],
    ['categories', '/shopping/vendor/categories'],
    ['inventory', '/shopping/vendor/inventory'],
    ['orders', '/shopping/vendor/orders'],
    ['returns', '/shopping/vendor/returns'],
    ['coupons', '/shopping/vendor/coupons'],
    ['reviews', '/shopping/vendor/reviews'],
    ['analytics', '/shopping/vendor/analytics'],
  ]) {
    r = await api.get(ep, auth(vc));
    rec('vendor', `GET ${name}`, r.status === 200, `status ${r.status}${r.status !== 200 ? ` ${short(r.data)}` : ''}`);
  }

  // Vendor sees ONLY their own orders
  const vcOrders = await api.get('/shopping/vendor/orders?limit=100', auth(vc));
  const voOrders = await api.get('/shopping/vendor/orders?limit=100', auth(vo));
  const idsOf = (res) => new Set((res.data?.data || []).map((o) => String(o.orderId || o._id)));
  const setC = idsOf(vcOrders);
  const setO = idsOf(voOrders);
  const overlap = [...setC].filter((x) => setO.has(x));
  rec('vendor', 'order lists do not overlap between vendors', overlap.length === 0,
    `cougar ${setC.size}, outfitters ${setO.size}, overlap ${overlap.length}`);

  /* ── THE CRITICAL ISOLATION TEST ── */
  console.log('\n--- VENDOR ISOLATION (cross-tenant) ---');
  const cougarProducts = await api.get('/shopping/vendor/products?limit=5', auth(vc));
  const cougarProd = (cougarProducts.data?.data || [])[0];
  const cougarOrderId = [...setC][0];

  if (cougarProd) {
    const pid = cougarProd.productId || cougarProd._id;
    r = await api.patch(`/shopping/vendor/products/${pid}`, { name: 'HACKED BY OUTFITTERS' }, auth(vo));
    rec('vendor', 'Outfitters MODIFY Cougar product → 403/404', r.status === 403 || r.status === 404,
      `status ${r.status}${r.status === 200 ? '  *** P0 DATA LEAK ***' : ''}`);
    r = await api.delete(`/shopping/vendor/products/${pid}`, auth(vo));
    rec('vendor', 'Outfitters DELETE Cougar product → 403/404', r.status === 403 || r.status === 404,
      `status ${r.status}${r.status === 200 ? '  *** P0 DATA LEAK ***' : ''}`);
  }
  if (cougarOrderId) {
    r = await api.get(`/shopping/vendor/orders/${cougarOrderId}`, auth(vo));
    rec('vendor', 'Outfitters READ Cougar order → 403/404', r.status === 403 || r.status === 404,
      `status ${r.status}${r.status === 200 ? '  *** P0 DATA LEAK ***' : ''}`);
    r = await api.patch(`/shopping/vendor/orders/${cougarOrderId}/status`, { status: 'confirmed' }, auth(vo));
    rec('vendor', 'Outfitters MODIFY Cougar order → 403/404', r.status === 403 || r.status === 404,
      `status ${r.status}${r.status === 200 ? '  *** P0 DATA LEAK ***' : ''}`);
  }
  const cougarInv = await api.get('/shopping/vendor/inventory?limit=5', auth(vc));
  const invRow = (cougarInv.data?.data || [])[0];
  if (invRow?.variantId) {
    r = await api.patch(`/shopping/vendor/inventory/${invRow.variantId}`,
      { stockQuantity: 99999, reason: 'cross-tenant probe' }, auth(vo));
    // Substance: the change must be DENIED. applyStockChange scopes its lookup
    // by brandId, so a foreign variant simply isn't found — denial is real.
    rec('vendor', 'Outfitters MODIFY Cougar inventory is DENIED', r.status >= 400,
      `status ${r.status}${r.status === 200 ? '  *** P0 DATA LEAK ***' : ''}`);
    // Semantics, tracked separately: denial arrives as 400 rather than 403/404.
    rec('vendor', 'cross-tenant inventory denial uses a 403/404 status (semantics)',
      r.status === 403 || r.status === 404, `status ${r.status} — P2, not a leak`);
    // And prove nothing actually changed.
    const after = await api.get('/shopping/vendor/inventory?limit=50', auth(vc));
    const row = (after.data?.data || []).find((x) => String(x.variantId) === String(invRow.variantId));
    rec('vendor', 'Cougar stock UNCHANGED after cross-tenant attempt',
      !row || row.stockQuantity !== 99999, `stock now ${row?.stockQuantity}`);
  }

  /* ── BRAND DATA CORRECTNESS + VENDOR→CUSTOMER PROPAGATION ── */
  // Requested explicitly: what a customer sees for a brand must be exactly
  // that brand's own data, the stock shown must be the stock the vendor holds,
  // and anything a vendor adds or changes must show up on the customer side.
  console.log('\n--- BRAND DATA / STOCK SYNC ---');

  const vendorCtx = [
    { name: 'Cougar', token: vc, slug: 'cougar' },
    { name: 'Outfitters', token: vo, slug: 'outfitters' },
  ];

  for (const v of vendorCtx) {
    const brandRes = await api.get('/shopping/vendor/brand', auth(v.token));
    const myBrandId = String(brandRes.data?.data?.brandId || brandRes.data?.data?._id || '');

    // 1. Every product the vendor owns belongs to their brand, and every
    //    product the customer sees under that brand belongs to it too.
    const mine = await api.get('/shopping/vendor/products?limit=200', auth(v.token));
    const mineList = mine.data?.data || [];
    const foreignOwned = mineList.filter((p) => String(p.brandId?._id || p.brandId) !== myBrandId);
    rec('sync', `${v.name}: vendor product list contains only own brand`,
      foreignOwned.length === 0, `${mineList.length} products, ${foreignOwned.length} foreign`);

    const pub = await api.get(`/shopping/products?brandId=${myBrandId}&limit=200`);
    const pubList = pub.data?.data || [];
    const foreignPublic = pubList.filter((p) => String(p.brandId?._id || p.brandId) !== myBrandId);
    rec('sync', `${v.name}: customer brand listing contains only that brand`,
      foreignPublic.length === 0, `${pubList.length} products, ${foreignPublic.length} foreign`);

    // 2. STOCK PARITY — the number a customer sees per variant must equal the
    //    vendor's inventory number for that same variant.
    const inv = await api.get('/shopping/vendor/inventory?limit=500', auth(v.token));
    const invMap = new Map(
      (inv.data?.data || []).map((row) => [String(row.variantId), row.stockQuantity])
    );
    let compared = 0;
    const mismatches = [];
    for (const p of pubList.slice(0, 25)) {
      const detail = await api.get(`/shopping/products/${p.productId || p._id}`);
      for (const variant of detail.data?.data?.variants || []) {
        const vid = String(variant.variantId || variant._id);
        if (!invMap.has(vid)) continue;
        compared += 1;
        if (invMap.get(vid) !== variant.stockQuantity) {
          mismatches.push(`${p.name}/${vid.slice(-6)}: vendor=${invMap.get(vid)} customer=${variant.stockQuantity}`);
        }
      }
    }
    rec('sync', `${v.name}: customer-visible stock == vendor inventory`,
      mismatches.length === 0 && compared > 0,
      `${compared} variants compared, ${mismatches.length} mismatched${mismatches.length ? ` → ${mismatches.slice(0, 3).join('; ')}` : ''}`);
  }

  // 3. PROPAGATION — a vendor stock change must be visible to the customer.
  const cInv = await api.get('/shopping/vendor/inventory?limit=50', auth(vc));
  const target = (cInv.data?.data || []).find((x) => x.stockQuantity > 0);
  if (target) {
    const original = target.stockQuantity;
    const bumped = original + 7;
    let res = await api.patch(`/shopping/vendor/inventory/${target.variantId}`,
      { stockQuantity: bumped, reason: 'triage propagation check' }, auth(vc));
    const wrote = res.status === 200;
    const detail = await api.get(`/shopping/products/${target.productId || target.product}`);
    const seen = (detail.data?.data?.variants || [])
      .find((x) => String(x.variantId || x._id) === String(target.variantId));
    rec('sync', 'vendor stock update is immediately visible to the customer',
      wrote && seen?.stockQuantity === bumped, `set ${bumped}, customer sees ${seen?.stockQuantity}`);
    // put it back
    await api.patch(`/shopping/vendor/inventory/${target.variantId}`,
      { stockQuantity: original, reason: 'triage restore' }, auth(vc));
  }

  // 4. PROPAGATION — a vendor price/name edit must be visible to the customer.
  const cProds = await api.get('/shopping/vendor/products?limit=5', auth(vc));
  const editTarget = (cProds.data?.data || [])[0];
  if (editTarget) {
    const pid = editTarget.productId || editTarget._id;
    const origPrice = editTarget.basePrice;
    const newPrice = Number(origPrice) + 111;
    let res = await api.patch(`/shopping/vendor/products/${pid}`, { basePrice: newPrice }, auth(vc));
    const wrote = res.status === 200;
    const detail = await api.get(`/shopping/products/${pid}`);
    rec('sync', 'vendor price edit is immediately visible to the customer',
      wrote && detail.data?.data?.basePrice === newPrice,
      `set ${newPrice}, customer sees ${detail.data?.data?.basePrice}`);
    await api.patch(`/shopping/vendor/products/${pid}`, { basePrice: origPrice }, auth(vc));
  }

  // 5. A brand's own dashboard/analytics counts must not include the other brand.
  for (const v of vendorCtx) {
    const dash = await api.get('/shopping/vendor/dashboard', auth(v.token));
    const ordersRes = await api.get('/shopping/vendor/orders?limit=500', auth(v.token));
    const realCount = (ordersRes.data?.data || []).length;
    const tile = dash.data?.data?.totalOrders ?? dash.data?.data?.orders ?? null;
    rec('sync', `${v.name}: dashboard order count matches its own orders`,
      tile === null || Number(tile) === realCount,
      tile === null ? 'no totalOrders tile exposed' : `tile=${tile} actual=${realCount}`);
  }

  /* ─────────────── ADMIN ─────────────── */
  console.log('\n--- ADMIN PATH ---');
  const adm = await login(ADMIN, 'admin');
  rec('admin', 'admin login', !!adm);
  if (adm) {
    for (const [name, ep] of [
      ['dashboard', '/shopping/admin/dashboard'],
      ['brands', '/shopping/admin/brands'],
      ['orders', '/shopping/admin/orders'],
      ['outlets', '/shopping/admin/outlets'],
      ['analytics', '/shopping/admin/analytics'],
      ['settings', '/shopping/admin/settings'],
    ]) {
      r = await api.get(ep, auth(adm));
      rec('admin', `GET ${name}`, r.status === 200, `status ${r.status}${r.status !== 200 ? ` ${short(r.data)}` : ''}`);
    }
  }

  /* ── RBAC ENUMERATION: every admin route vs customer / vendor / no token ── */
  console.log('\n--- ADMIN RBAC ENUMERATION ---');
  const adminGets = [
    '/shopping/admin/dashboard', '/shopping/admin/brands', '/shopping/admin/orders',
    '/shopping/admin/outlets', '/shopping/admin/analytics', '/shopping/admin/settings',
  ];
  for (const ep of adminGets) {
    for (const [who, tok] of [['customer', cust], ['vendor', vc], ['no-token', null]]) {
      const res = await api.get(ep, tok ? auth(tok) : {});
      const denied = res.status === 401 || res.status === 403;
      rec('admin', `${who} on ${ep.replace('/shopping/admin', '')} denied`, denied,
        `status ${res.status}${res.status === 200 ? '  *** RBAC LEAK ***' : ''}`);
    }
  }

  finish();

  function finish() {
    console.log(`\n=== PROBE RESULT: ${ok} ok, ${bad} problems ===\n`);
    require('fs').writeFileSync(
      require('path').join(__dirname, '..', 'shopping-triage-results.json'),
      JSON.stringify({ findings, ok, bad, at: new Date().toISOString() }, null, 2)
    );
    process.exit(0);
  }
})().catch((e) => {
  console.error('PROBE CRASHED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
