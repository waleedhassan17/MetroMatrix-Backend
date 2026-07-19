/**
 * Unit tests for the order state machine, actor rules and split maths (pure logic).
 */
const {
  ALLOWED_TRANSITIONS,
  canTransition,
  assertActorAllowed,
  splitByBrand,
  allocateProportional,
} = require('../services/orderService');

describe('order state machine', () => {
  const LEGAL = [
    ['pending', 'confirmed'],
    ['pending', 'cancelled'],
    ['confirmed', 'processing'],
    ['confirmed', 'cancelled'],
    ['processing', 'shipped'],
    ['processing', 'cancelled'],
    ['shipped', 'out_for_delivery'],
    ['out_for_delivery', 'delivered'],
    ['delivered', 'returned'],
    ['returned', 'refunded'],
  ];

  it.each(LEGAL)('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  const ILLEGAL = [
    ['pending', 'shipped'],
    ['pending', 'delivered'],
    ['confirmed', 'delivered'],
    ['shipped', 'cancelled'],
    ['delivered', 'cancelled'],
    ['cancelled', 'confirmed'],
    ['refunded', 'pending'],
    ['delivered', 'pending'],
    ['out_for_delivery', 'processing'],
  ];

  it.each(ILLEGAL)('rejects %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('cancelled and refunded are terminal', () => {
    expect(ALLOWED_TRANSITIONS.cancelled).toEqual([]);
    expect(ALLOWED_TRANSITIONS.refunded).toEqual([]);
  });
});

describe('actor rules', () => {
  it('customer may cancel while pending or confirmed', () => {
    expect(assertActorAllowed('pending', 'cancelled', 'customer').ok).toBe(true);
    expect(assertActorAllowed('confirmed', 'cancelled', 'customer').ok).toBe(true);
  });

  it('customer may NOT cancel once processing', () => {
    const r = assertActorAllowed('processing', 'cancelled', 'customer');
    expect(r.ok).toBe(false);
  });

  it('customer may not drive fulfilment', () => {
    expect(assertActorAllowed('pending', 'confirmed', 'customer').ok).toBe(false);
    expect(assertActorAllowed('out_for_delivery', 'delivered', 'customer').ok).toBe(false);
  });

  it('vendor drives the fulfilment chain', () => {
    expect(assertActorAllowed('pending', 'confirmed', 'vendor').ok).toBe(true);
    expect(assertActorAllowed('confirmed', 'processing', 'vendor').ok).toBe(true);
    expect(assertActorAllowed('processing', 'shipped', 'vendor').ok).toBe(true);
    expect(assertActorAllowed('shipped', 'out_for_delivery', 'vendor').ok).toBe(true);
    expect(assertActorAllowed('out_for_delivery', 'delivered', 'vendor').ok).toBe(true);
  });

  it('vendor cannot make an illegal move even in role', () => {
    expect(assertActorAllowed('pending', 'delivered', 'vendor').ok).toBe(false);
  });

  it('admin may force any legal transition', () => {
    expect(assertActorAllowed('processing', 'cancelled', 'admin').ok).toBe(true);
    expect(assertActorAllowed('delivered', 'returned', 'admin').ok).toBe(true);
  });

  it('admin still cannot break the state machine', () => {
    expect(assertActorAllowed('cancelled', 'delivered', 'admin').ok).toBe(false);
  });
});

describe('splitByBrand', () => {
  it('groups lines per brand preserving order', () => {
    const map = splitByBrand([
      { brandId: 'a', totalPrice: 1 },
      { brandId: 'b', totalPrice: 2 },
      { brandId: 'a', totalPrice: 3 },
    ]);
    expect([...map.keys()]).toEqual(['a', 'b']);
    expect(map.get('a')).toHaveLength(2);
  });
});

describe('allocateProportional', () => {
  it('splits proportionally and reconciles exactly', () => {
    const parts = allocateProportional(500, [4000, 1000]);
    expect(parts).toEqual([400, 100]);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(500);
  });

  it('handles rounding with largest remainder — sum always exact', () => {
    const parts = allocateProportional(100, [1, 1, 1]);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(100);
    expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
  });

  it('returns zeros for zero amount or zero weights', () => {
    expect(allocateProportional(0, [10, 20])).toEqual([0, 0]);
    expect(allocateProportional(100, [0, 0])).toEqual([0, 0]);
  });

  it('multi-brand order totals reconcile: subtotal - discount + shipping', () => {
    // Brand A: 4000, Brand B: 1500; platform coupon 550; shipping 0 + 150
    const subtotals = [4000, 1500];
    const discountSplit = allocateProportional(550, subtotals);
    const shipping = [0, 150];
    const childTotals = subtotals.map((s, i) => s - discountSplit[i] + shipping[i]);
    const groupTotal = 4000 + 1500 - 550 + 150;
    expect(childTotals.reduce((s, t) => s + t, 0)).toBe(groupTotal);
  });
});
