/**
 * Shopping critical-path smoke test.
 *
 * Path: login → browse brands → filter products → add items from 2 different
 * brands to cart → apply coupon → checkout with wallet → verify 2 per-brand
 * orders with reconciling split totals → vendor moves one to shipped →
 * customer tracks it → vendor delivers → customer reviews.
 *
 * Prereqs: server running, `node scripts/seed-shopping.js` run once.
 * Run:     API_URL=http://localhost:5000 node scripts/smoke-shopping.js
 */
require('dotenv').config();
const axios = require('axios');

const BASE = process.env.API_URL || 'http://localhost:5000';
const api = axios.create({ baseURL: `${BASE}/api`, validateStatus: () => true });

const CUSTOMER = { email: 'customer.demo@metromatrix.pk', password: 'Customer@123' };
const VENDORS = {
  // brand slug → vendor login (from seed-shopping.js)
  outfitters: { email: 'vendor.outfitters@metromatrix.pk', password: 'Vendor@123' },
  khaadi: { email: 'vendor.khaadi@metromatrix.pk', password: 'Vendor@123' },
  'servis-steps': { email: 'vendor.servis@metromatrix.pk', password: 'Vendor@123' },
  techmart: { email: 'vendor.techmart@metromatrix.pk', password: 'Vendor@123' },
};

let passed = 0;
let failed = 0;
const step = (name, ok, detail = '') => {
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (ok) passed += 1;
  else failed += 1;
  return ok;
};
const bail = (name, detail) => {
  step(name, false, detail);
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(1);
};

const auth = (token) => ({ headers: { Authorization: `Bearer ${token}` } });

(async () => {
  console.log(`=== Shopping smoke test against ${BASE} ===\n`);

  // 1. Customer login
  let res = await api.post('/auth/login', CUSTOMER);
  if (!res.data?.accessToken) bail('customer login', JSON.stringify(res.data).slice(0, 120));
  const customerToken = res.data.accessToken;
  step('customer login', true);

  // 2. Browse brands
  res = await api.get('/shopping/brands?limit=10');
  const brands = res.data?.data || [];
  step('browse brands', res.status === 200 && brands.length >= 2, `${brands.length} active brands`);
  if (brands.length < 2) bail('need at least 2 active brands', 'run seed-shopping.js first');
  const [brandA, brandB] = brands;

  // 3. Filter products
  res = await api.get(`/shopping/products?brandId=${brandA.brandId}&inStock=true&sortBy=price_asc&limit=5`);
  const productsA = res.data?.data || [];
  step('filter products (brand A, inStock, price_asc)', res.status === 200 && productsA.length > 0, `${productsA.length} products`);
  res = await api.get(`/shopping/products?brandId=${brandB.brandId}&inStock=true&limit=5`);
  const productsB = res.data?.data || [];
  step('filter products (brand B)', res.status === 200 && productsB.length > 0, `${productsB.length} products`);
  if (!productsA.length || !productsB.length) bail('products missing', 'seed data incomplete');

  const pickVariant = (p) => p.variants.find((v) => v.stockQuantity > 0);
  const pA = productsA.find(pickVariant);
  const pB = productsB.find(pickVariant);

  // 4. Clear cart, then add 2 items from 2 different brands
  await api.delete('/shopping/cart', auth(customerToken));
  res = await api.post(
    '/shopping/cart/items',
    { productId: pA.productId, variantId: pickVariant(pA).variantId, quantity: 1 },
    auth(customerToken)
  );
  const okA = res.status === 200;
  res = await api.post(
    '/shopping/cart/items',
    { productId: pB.productId, variantId: pickVariant(pB).variantId, quantity: 2 },
    auth(customerToken)
  );
  const cart = res.data?.data;
  const brandCount = cart ? new Set(cart.items.map((i) => i.brandId)).size : 0;
  step('add items from 2 different brands to cart', okA && res.status === 200 && brandCount === 2, `cart has ${cart?.items.length} lines from ${brandCount} brands, total PKR ${cart?.total}`);

  // 5. Apply coupon (platform-wide WELCOME10 from seed)
  res = await api.post('/shopping/cart/coupon', { couponCode: 'WELCOME10' }, auth(customerToken));
  const couponOk = res.status === 200 && res.data?.data?.discount > 0;
  step('apply coupon WELCOME10', couponOk, couponOk ? `discount PKR ${res.data.data.discount}` : JSON.stringify(res.data).slice(0, 100));

  // 6. Checkout with wallet
  res = await api.get('/shopping/addresses', auth(customerToken));
  const address = (res.data?.data || [])[0];
  res = await api.post(
    '/shopping/checkout',
    address ? { addressId: address.addressId, paymentMethod: 'wallet' } : {
      shippingAddress: {
        fullName: 'Smoke Test', phone: '03000000000',
        addressLine1: 'Test Street 1', city: 'Lahore', country: 'Pakistan',
      },
      paymentMethod: 'wallet',
    },
    auth(customerToken)
  );
  const group = res.data?.data;
  if (res.status !== 201 || !group) bail('checkout with wallet', JSON.stringify(res.data).slice(0, 160));
  step('checkout with wallet', group.paymentStatus === 'paid', `group ${group.odexId} paid, total PKR ${group.total}`);

  // 7. Verify 2 per-brand orders with reconciling split totals
  const childSum = group.orders.reduce((s, o) => s + o.total, 0);
  step(
    'order split into per-brand orders with correct totals',
    group.orders.length === 2 && childSum === group.total,
    `${group.orders.length} child orders, children sum ${childSum} vs group ${group.total}`
  );

  // 8. Vendor login (owner of the first child order's brand) and move order along
  const childOrder = group.orders[0];
  const childBrand = brands.find((b) => b.brandId === childOrder.brandId);
  const vendorCreds = VENDORS[childBrand?.slug];
  if (!vendorCreds) bail('vendor lookup', `no seed vendor for brand slug ${childBrand?.slug}`);
  res = await api.post('/auth/provider/login', vendorCreds);
  const vendorToken = res.data?.accessToken;
  if (!vendorToken) bail('vendor login', JSON.stringify(res.data).slice(0, 120));
  step('vendor login', true, vendorCreds.email);

  // pending → confirmed → processing → shipped
  for (const status of ['confirmed', 'processing', 'shipped']) {
    res = await api.patch(
      `/shopping/vendor/orders/${childOrder.orderId}/status`,
      { status, trackingNumber: status === 'shipped' ? 'TCS-SMOKE-001' : undefined },
      auth(vendorToken)
    );
    if (res.status !== 200) bail(`vendor moves order to ${status}`, JSON.stringify(res.data).slice(0, 120));
  }
  step('vendor moves order to shipped (with tracking number)', true);

  // 9. Customer tracks the order
  res = await api.get(`/shopping/orders/${childOrder.orderId}/tracking`, auth(customerToken));
  const tracking = res.data?.data;
  step(
    'customer tracks order',
    res.status === 200 && tracking?.orderStatus === 'shipped' && tracking?.trackingNumber === 'TCS-SMOKE-001',
    `status ${tracking?.orderStatus}, tracking ${tracking?.trackingNumber}`
  );

  // 10. Vendor delivers
  for (const status of ['out_for_delivery', 'delivered']) {
    res = await api.patch(
      `/shopping/vendor/orders/${childOrder.orderId}/status`,
      { status },
      auth(vendorToken)
    );
    if (res.status !== 200) bail(`vendor moves order to ${status}`, JSON.stringify(res.data).slice(0, 120));
  }
  step('vendor marks delivered', true);

  // 11. Customer reviews a purchased product
  const reviewedProductId = childOrder.items[0].productId;
  res = await api.post(
    `/shopping/products/${reviewedProductId}/review`,
    { rating: 5, title: 'Smoke test review', comment: 'Arrived quickly, exactly as described.' },
    auth(customerToken)
  );
  step(
    'customer reviews purchased product (verified purchase)',
    res.status === 201 && res.data?.data?.isVerifiedPurchase === true,
    res.status === 201 ? 'review accepted' : JSON.stringify(res.data).slice(0, 120)
  );

  // 12. Guard: review without purchase must be rejected
  const unbought = productsB.find((p) => p.productId !== reviewedProductId && !childOrder.items.some((i) => i.productId === p.productId));
  if (unbought) {
    res = await api.post(
      `/shopping/products/${unbought.productId}/review`,
      { rating: 5, comment: 'Should not be allowed' },
      auth(customerToken)
    );
    step('review without delivered purchase is rejected', res.status === 403 || res.status === 400, `status ${res.status}`);
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Smoke test crashed:', err.message);
  process.exit(1);
});
