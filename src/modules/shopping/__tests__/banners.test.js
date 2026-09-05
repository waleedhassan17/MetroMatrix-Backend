/**
 * Unit tests for the storefront promo banner window filter (pure logic) and
 * the per-brand cart breakdown that replaced the client's hardcoded shipping.
 *
 * Context: banners were a hardcoded fixture in the app pointing at a brand id
 * that did not exist, and the cart screen computed shipping from its own copy
 * of the fee and threshold. Both are server-owned now.
 */
const { buildActiveBannerQuery } = require('../services/catalogService');
const { computeBrandBreakdown } = require('../services/cartService');

const SETTINGS = { shippingFeePerBrand: 150, freeShippingThreshold: 3000 };
const NOW = new Date('2026-09-05T12:00:00Z');

/**
 * Evaluate the Mongo filter in memory so the window logic is testable without
 * a database. Only the operators buildActiveBannerQuery actually emits are
 * supported.
 */
const matches = (banner, query) => {
  if (query.isActive !== undefined && banner.isActive !== query.isActive) return false;
  return query.$and.every((clause) =>
    clause.$or.some((cond) => {
      const [field] = Object.keys(cond);
      const expected = cond[field];
      const value = banner[field] === undefined ? null : banner[field];
      if (expected === null) return value === null;
      if (expected.$lte !== undefined) return value !== null && value <= expected.$lte;
      if (expected.$gte !== undefined) return value !== null && value >= expected.$gte;
      return false;
    })
  );
};

const day = 24 * 60 * 60 * 1000;
const banner = (over = {}) => ({
  isActive: true,
  validFrom: null,
  validUntil: null,
  ...over,
});

describe('buildActiveBannerQuery', () => {
  const query = buildActiveBannerQuery(NOW);

  it('shows a banner with no date bounds at all', () => {
    expect(matches(banner(), query)).toBe(true);
  });

  it('shows a banner whose window is open right now', () => {
    const b = banner({
      validFrom: new Date(NOW.getTime() - day),
      validUntil: new Date(NOW.getTime() + day),
    });
    expect(matches(b, query)).toBe(true);
  });

  it('hides a banner that has not started yet', () => {
    const b = banner({ validFrom: new Date(NOW.getTime() + day) });
    expect(matches(b, query)).toBe(false);
  });

  it('hides a banner whose window has closed', () => {
    const b = banner({ validUntil: new Date(NOW.getTime() - day) });
    expect(matches(b, query)).toBe(false);
  });

  it('hides a deactivated banner regardless of its window', () => {
    expect(query.isActive).toBe(true);
    expect(matches(banner({ isActive: false }), query)).toBe(false);
  });

  it('treats a one-sided window as open on the unbounded side', () => {
    const started = banner({ validFrom: new Date(NOW.getTime() - day) });
    const endsLater = banner({ validUntil: new Date(NOW.getTime() + day) });
    expect(matches(started, query)).toBe(true);
    expect(matches(endsLater, query)).toBe(true);
  });

  it('treats a missing field the same as an explicit null', () => {
    const legacy = { isActive: true }; // written before the window fields existed
    expect(matches(legacy, query)).toBe(true);
  });
});

describe('computeBrandBreakdown', () => {
  const item = (brandId, unitPrice, quantity = 1, brandName = '') => ({
    brandId,
    unitPrice,
    quantity,
    brandName,
  });

  it('groups lines by brand and sums each subtotal', () => {
    const rows = computeBrandBreakdown(
      [item('a', 1000, 2, 'Cougar'), item('a', 500, 1, 'Cougar'), item('b', 800, 1, 'Outfitters')],
      SETTINGS
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      brandId: 'a',
      brandName: 'Cougar',
      subtotal: 2500,
      shippingFee: 150,
    });
    expect(rows[1].subtotal).toBe(800);
  });

  it('waives the fee per brand at the threshold, not across the cart', () => {
    const rows = computeBrandBreakdown([item('a', 3000), item('b', 1000)], SETTINGS);
    expect(rows.find((r) => r.brandId === 'a').shippingFee).toBe(0);
    expect(rows.find((r) => r.brandId === 'b').shippingFee).toBe(150);
  });

  it('sums to the same shipping total the cart charges', () => {
    const items = [item('a', 1000), item('b', 1000), item('c', 4000)];
    const rows = computeBrandBreakdown(items, SETTINGS);
    const { computeShippingFee } = require('../services/cartService');
    expect(rows.reduce((s, r) => s + r.shippingFee, 0)).toBe(
      computeShippingFee(items, SETTINGS)
    );
  });

  it('returns an empty list for an empty cart', () => {
    expect(computeBrandBreakdown([], SETTINGS)).toEqual([]);
  });

  it('tracks the settings rather than a hardcoded 150 / 3000', () => {
    const rows = computeBrandBreakdown([item('a', 1000)], {
      shippingFeePerBrand: 99,
      freeShippingThreshold: 500,
    });
    expect(rows[0].shippingFee).toBe(0); // 1000 is over the lowered threshold
  });
});
