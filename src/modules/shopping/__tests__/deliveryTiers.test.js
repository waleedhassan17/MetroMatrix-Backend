/**
 * Unit tests for the delivery speed tiers (pure logic).
 *
 * Context: the tiers used to be a hardcoded array in the app, and the chosen id
 * was sent to POST /checkout but never read — so a shopper picking "Same Day"
 * saw +500 on the review screen and was charged the standard total. These tests
 * pin the two halves of the fix: the tier must resolve to a real price, and the
 * surcharge must still split across per-brand child orders to the exact rupee.
 */
const {
  DEFAULT_DELIVERY_TIERS,
  normaliseDeliveryTiers,
  resolveDeliveryTier,
} = require('../services/settingsService');
const { computeTotals } = require('../services/cartService');
const { allocateProportional } = require('../services/orderService');

const SETTINGS = {
  shippingFeePerBrand: 150,
  freeShippingThreshold: 3000,
  deliveryTiers: DEFAULT_DELIVERY_TIERS,
};

const item = (brandId, unitPrice, quantity = 1) => ({ brandId, unitPrice, quantity });

describe('resolveDeliveryTier', () => {
  it('resolves each default tier to its advertised price', () => {
    expect(resolveDeliveryTier(SETTINGS, 'standard').surcharge).toBe(0);
    expect(resolveDeliveryTier(SETTINGS, 'express').surcharge).toBe(250);
    expect(resolveDeliveryTier(SETTINGS, 'same-day').surcharge).toBe(500);
  });

  it('returns null for an unknown id rather than falling back to standard', () => {
    expect(resolveDeliveryTier(SETTINGS, 'teleport')).toBeNull();
    expect(resolveDeliveryTier(SETTINGS, '')).toBeNull();
  });

  it('returns null for a tier an admin has disabled', () => {
    const settings = {
      ...SETTINGS,
      deliveryTiers: [{ id: 'same-day', name: 'Same Day', surcharge: 500, isActive: false }],
    };
    expect(resolveDeliveryTier(settings, 'same-day')).toBeNull();
  });

  it('survives a settings document with no tiers at all', () => {
    expect(resolveDeliveryTier({}, 'express')).toBeNull();
  });
});

describe('normaliseDeliveryTiers', () => {
  it('keeps well-formed tiers and rounds the surcharge', () => {
    const tiers = normaliseDeliveryTiers([
      { id: 'express', name: 'Express', eta: '2-3 days', surcharge: 249.6 },
    ]);
    expect(tiers).toEqual([
      {
        id: 'express',
        name: 'Express',
        eta: '2-3 days',
        description: '',
        surcharge: 250,
        isActive: true,
      },
    ]);
  });

  it('drops entries with no id or no name, and de-duplicates ids', () => {
    const tiers = normaliseDeliveryTiers([
      { id: 'a', name: 'A' },
      { id: '', name: 'No id' },
      { id: 'b', name: '' },
      { id: 'a', name: 'Duplicate' },
    ]);
    expect(tiers.map((t) => t.id)).toEqual(['a']);
  });

  it('refuses a negative or non-numeric surcharge instead of storing it', () => {
    const [tier] = normaliseDeliveryTiers([{ id: 'x', name: 'X', surcharge: -100 }]);
    expect(tier.surcharge).toBe(0);
    const [other] = normaliseDeliveryTiers([{ id: 'y', name: 'Y', surcharge: 'free' }]);
    expect(other.surcharge).toBe(0);
  });

  it('returns null for a payload that would empty the tier list', () => {
    expect(normaliseDeliveryTiers([])).toBeNull();
    expect(normaliseDeliveryTiers([{ id: '', name: '' }])).toBeNull();
    expect(normaliseDeliveryTiers('express')).toBeNull();
    expect(normaliseDeliveryTiers(null)).toBeNull();
  });
});

describe('computeTotals with a delivery surcharge', () => {
  it('adds the surcharge to shipping and to the total', () => {
    const lines = [item('a', 1000)];
    const totals = computeTotals(lines, 0, SETTINGS, 500);
    expect(totals.subtotal).toBe(1000);
    expect(totals.shippingFee).toBe(650); // 150 brand fee + 500 same-day
    expect(totals.total).toBe(1650);
  });

  it('defaults to no surcharge, so a plain cart read is unchanged', () => {
    const lines = [item('a', 1000)];
    expect(computeTotals(lines, 0, SETTINGS)).toEqual(
      computeTotals(lines, 0, SETTINGS, 0)
    );
  });

  it('still applies the surcharge when every brand ships free', () => {
    const lines = [item('a', 5000)];
    const totals = computeTotals(lines, 0, SETTINGS, 250);
    expect(totals.shippingFee).toBe(250);
    expect(totals.total).toBe(5250);
  });
});

describe('surcharge apportionment across per-brand orders', () => {
  /**
   * checkoutService spreads the group-level surcharge over the child orders
   * with allocateProportional, the same helper the discount uses. The invariant
   * scripts/shopping-integrity.js asserts is that children sum to the group
   * exactly — these cases are the ones that would break it.
   */
  const reconcile = (surcharge, brandSubtotals) => {
    const split = allocateProportional(surcharge, brandSubtotals);
    return { split, sum: split.reduce((s, n) => s + n, 0) };
  };

  it('splits a surcharge across two brands to the exact rupee', () => {
    const { split, sum } = reconcile(500, [4000, 1000]);
    expect(split).toEqual([400, 100]);
    expect(sum).toBe(500);
  });

  it('reconciles exactly even when the split does not divide evenly', () => {
    const { sum } = reconcile(250, [1000, 1000, 1000]);
    expect(sum).toBe(250);
  });

  it('contributes nothing when standard (surcharge 0) is chosen', () => {
    const { split, sum } = reconcile(0, [4000, 1000]);
    expect(split).toEqual([0, 0]);
    expect(sum).toBe(0);
  });

  it('puts the whole surcharge on the only brand in a single-brand order', () => {
    const { split } = reconcile(500, [2698]);
    expect(split).toEqual([500]);
  });

  it('keeps children summing to the group total, surcharge included', () => {
    const brandSubtotals = [2698, 3190];
    const discount = 405;
    const surcharge = 250;
    const shipping = [150, 0]; // second brand is over the free-shipping threshold

    const discountSplit = allocateProportional(discount, brandSubtotals);
    const surchargeSplit = allocateProportional(surcharge, brandSubtotals);

    const childTotals = brandSubtotals.map(
      (sub, i) => sub - discountSplit[i] + shipping[i] + surchargeSplit[i]
    );
    const groupTotal =
      brandSubtotals.reduce((s, n) => s + n, 0) -
      discount +
      shipping.reduce((s, n) => s + n, 0) +
      surcharge;

    expect(childTotals.reduce((s, n) => s + n, 0)).toBe(groupTotal);
  });
});
