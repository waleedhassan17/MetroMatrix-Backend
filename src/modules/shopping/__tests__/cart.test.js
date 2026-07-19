/**
 * Unit tests for cart totals, shipping rule and coupon validation (pure logic).
 */
const {
  computeShippingFee,
  evaluateCoupon,
  computeTotals,
  unitPriceFor,
} = require('../services/cartService');

const SETTINGS = { shippingFeePerBrand: 150, freeShippingThreshold: 3000 };

const item = (brandId, unitPrice, quantity = 1) => ({ brandId, unitPrice, quantity });

const day = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-19T12:00:00Z');
const coupon = (over = {}) => ({
  couponCode: 'TEST',
  brandId: null,
  type: 'percentage',
  value: 10,
  minOrderAmount: 0,
  maxDiscount: 0,
  validFrom: new Date(NOW.getTime() - day),
  validUntil: new Date(NOW.getTime() + day),
  usageLimit: 0,
  usedCount: 0,
  isActive: true,
  ...over,
});

describe('computeShippingFee', () => {
  it('charges per brand below the threshold', () => {
    const fee = computeShippingFee([item('a', 1000), item('b', 1000)], SETTINGS);
    expect(fee).toBe(300);
  });

  it('waives fee for a brand at/above the threshold, per brand', () => {
    const fee = computeShippingFee([item('a', 3000), item('b', 1000)], SETTINGS);
    expect(fee).toBe(150);
  });

  it('is zero for an empty cart', () => {
    expect(computeShippingFee([], SETTINGS)).toBe(0);
  });
});

describe('evaluateCoupon', () => {
  const items = [item('a', 2000, 2), item('b', 1000)]; // subtotal 5000

  it('rejects an unknown coupon', () => {
    expect(evaluateCoupon(null, items, NOW)).toEqual({ ok: false, reason: 'Invalid coupon code' });
  });

  it('rejects an expired coupon', () => {
    const r = evaluateCoupon(coupon({ validUntil: new Date(NOW.getTime() - day) }), items, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/expired/i);
  });

  it('rejects a not-yet-valid coupon', () => {
    const r = evaluateCoupon(coupon({ validFrom: new Date(NOW.getTime() + day) }), items, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not active yet/i);
  });

  it('rejects when usage limit reached', () => {
    const r = evaluateCoupon(coupon({ usageLimit: 5, usedCount: 5 }), items, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/usage limit/i);
  });

  it('rejects below minimum order amount', () => {
    const r = evaluateCoupon(coupon({ minOrderAmount: 6000 }), items, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Minimum order of PKR 6000/);
  });

  it('caps percentage discounts at maxDiscount', () => {
    const r = evaluateCoupon(coupon({ value: 50, maxDiscount: 500 }), items, NOW);
    expect(r).toEqual({ ok: true, discount: 500 });
  });

  it('computes an uncapped percentage discount', () => {
    const r = evaluateCoupon(coupon({ value: 10 }), items, NOW);
    expect(r).toEqual({ ok: true, discount: 500 }); // 10% of 5000
  });

  it('applies brand-scoped coupons only to that brand lines', () => {
    const r = evaluateCoupon(coupon({ brandId: 'a', value: 10 }), items, NOW);
    expect(r).toEqual({ ok: true, discount: 400 }); // 10% of brand-a 4000
  });

  it('rejects a brand coupon when cart has none of that brand', () => {
    const r = evaluateCoupon(coupon({ brandId: 'zzz' }), items, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/only applies/i);
  });

  it('fixed coupons never exceed the eligible amount', () => {
    const r = evaluateCoupon(coupon({ type: 'fixed', value: 99999 }), items, NOW);
    expect(r).toEqual({ ok: true, discount: 5000 });
  });
});

describe('computeTotals', () => {
  it('reconciles subtotal - discount + shipping', () => {
    const items = [item('a', 2000, 2)]; // 4000, brand over threshold → free shipping
    const t = computeTotals(items, 400, SETTINGS);
    expect(t).toEqual({ subtotal: 4000, discount: 400, shippingFee: 0, total: 3600 });
  });
});

describe('unitPriceFor', () => {
  it('uses salePrice when set and adds variant additionalPrice', () => {
    expect(unitPriceFor({ basePrice: 2000, salePrice: 1500 }, { additionalPrice: 100 })).toBe(1600);
  });
  it('falls back to basePrice', () => {
    expect(unitPriceFor({ basePrice: 2000, salePrice: null }, {})).toBe(2000);
  });
});
