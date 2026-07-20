const Order = require('../models/Order');
const OrderGroup = require('../models/OrderGroup');
const Brand = require('../models/Brand');
const Product = require('../models/Product');
const WalletService = require('../../../services/walletService');
const { getShoppingSettings } = require('./settingsService');

/**
 * ── Order state machine (single source of truth) ───────────────────
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['out_for_delivery'],
  out_for_delivery: ['delivered'],
  delivered: ['returned'],
  returned: ['refunded'],
  cancelled: [],
  refunded: [],
});

const canTransition = (from, to) => (ALLOWED_TRANSITIONS[from] || []).includes(to);

/**
 * Actor rules (pure — unit-testable):
 * - vendor drives fulfilment: pending→confirmed→processing→shipped→out_for_delivery→delivered,
 *   plus return handling delivered→returned→refunded and vendor-side cancels while pending/confirmed/processing.
 * - customer may ONLY cancel, and only while pending or confirmed.
 * - admin may force any legal transition (recorded with their id + reason).
 */
const assertActorAllowed = (currentStatus, nextStatus, role) => {
  if (!canTransition(currentStatus, nextStatus)) {
    return { ok: false, reason: `Cannot move an order from '${currentStatus}' to '${nextStatus}'` };
  }
  if (role === 'admin') return { ok: true };
  if (role === 'customer') {
    if (nextStatus === 'cancelled' && ['pending', 'confirmed'].includes(currentStatus)) {
      return { ok: true };
    }
    return { ok: false, reason: 'You can only cancel an order before it is being processed' };
  }
  if (role === 'vendor') {
    const vendorMoves = [
      'confirmed',
      'processing',
      'shipped',
      'out_for_delivery',
      'delivered',
      'returned',
      'refunded',
      'cancelled',
    ];
    if (vendorMoves.includes(nextStatus)) return { ok: true };
    return { ok: false, reason: 'Vendors cannot perform this transition' };
  }
  return { ok: false, reason: 'Unknown actor role' };
};

class TransitionError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

/**
 * Apply a status transition: validates the move + actor, appends to the
 * append-only statusHistory, and runs side effects (COD payment capture,
 * vendor payout on delivered, stock restore on cancel).
 */
const transition = async (order, nextStatus, actor, { note, trackingNumber } = {}) => {
  const check = assertActorAllowed(order.orderStatus, nextStatus, actor.role);
  if (!check.ok) throw new TransitionError(check.reason);

  order.orderStatus = nextStatus;
  if (trackingNumber !== undefined && trackingNumber !== null && trackingNumber !== '') {
    order.trackingNumber = trackingNumber;
  }
  order.statusHistory.push({
    status: nextStatus,
    changedBy: { id: actor.id, role: actor.role },
    changedAt: new Date(),
    note: note || undefined,
  });

  if (nextStatus === 'cancelled') {
    await restoreStock(order);
    if (order.paymentStatus === 'paid') {
      await refundToCustomer(order, `Refund for cancelled order ${order.odexId}`);
    }
  }

  if (nextStatus === 'delivered') {
    order.deliveredAt = new Date();
    if (order.paymentMethod === 'cod' && order.paymentStatus === 'pending') {
      order.paymentStatus = 'paid';
    }
    await payoutVendor(order);
  }

  if (nextStatus === 'refunded') {
    if (order.paymentStatus === 'paid') {
      await refundToCustomer(order, `Refund for returned order ${order.odexId}`);
    }
    order.paymentStatus = 'refunded';
    await reverseVendorPayout(order);
  }

  await order.save();
  await syncGroupPaymentStatus(order.orderGroup);
  return order;
};

/** Put every unit of an order's lines back into variant stock. */
const restoreStock = async (order) => {
  for (const item of order.items) {
    await Product.updateOne(
      { _id: item.productId, 'variants._id': item.variantId },
      { $inc: { 'variants.$.stockQuantity': item.quantity } }
    );
    const product = await Product.findById(item.productId);
    if (product) {
      product.syncStockFlag();
      await product.save();
    }
  }
};

/** Credit the customer's wallet with the order total. */
const refundToCustomer = async (order, description) => {
  const wallet = await WalletService.getOrCreateWallet(order.userId, 'User');
  await wallet.credit(order.total);
  await WalletService.recordTransaction(wallet._id, {
    type: 'credit',
    amount: order.total,
    description,
    source: 'refund',
    status: 'completed',
    relatedTo: { kind: 'Order', id: order._id },
    metadata: { shoppingOrderId: String(order._id), orderGroupId: String(order.orderGroup) },
  });
  order.paymentStatus = 'refunded';
};

/**
 * Vendor payout on delivery: credit the brand owner's Provider wallet with
 * order total minus platform commission, and credit the commission itself
 * to the Platform ledger (WalletService.settlePayout — Part C.3). The
 * customer already paid at checkout; this is the deferred earn-on-delivery
 * leg, not a fresh payer→payee transfer.
 */
const payoutVendor = async (order) => {
  if (order.vendorPayout && order.vendorPayout.paidAt) return; // idempotent
  const brand = await Brand.findById(order.brandId);
  if (!brand || !brand.owner) return; // admin-owned brand: no payout ledger

  const { commissionPercent } = await getShoppingSettings();
  const result = await WalletService.settlePayout({
    payeeType: 'Provider',
    payeeId: brand.owner,
    amount: order.total,
    source: 'shopping_earning',
    relatedTo: { kind: 'Order', id: order._id },
    description: `Earnings for order ${order.odexId}`,
    commissionRate: commissionPercent,
  });

  order.vendorPayout = {
    amount: result.payeeTransaction.amount,
    commission: result.commission,
    paidAt: new Date(),
    walletTransactionId: result.payeeTransaction._id,
  };
};

/** Reverse an already-made vendor payout when the order is refunded. */
const reverseVendorPayout = async (order) => {
  if (!order.vendorPayout || !order.vendorPayout.paidAt) return;
  const brand = await Brand.findById(order.brandId);
  if (!brand || !brand.owner) return;

  await WalletService.reversePayout({
    payeeType: 'Provider',
    payeeId: brand.owner,
    relatedTo: { kind: 'Order', id: order._id },
  });
  order.vendorPayout.paidAt = null;
};

/** Group paymentStatus mirrors its children (all refunded → refunded, any paid → paid). */
const syncGroupPaymentStatus = async (groupId) => {
  const group = await OrderGroup.findById(groupId);
  if (!group) return;
  const children = await Order.find({ orderGroup: group._id });
  if (children.length === 0) return;
  if (children.every((o) => o.paymentStatus === 'refunded')) group.paymentStatus = 'refunded';
  else if (children.every((o) => o.paymentStatus === 'paid' || o.paymentStatus === 'refunded')) {
    group.paymentStatus = 'paid';
  }
  await group.save();
};

/**
 * ── Pure split helpers (unit-tested) ───────────────────────────────
 */

/** Group cart lines by brand. */
const splitByBrand = (items) => {
  const map = new Map();
  items.forEach((it) => {
    const key = String(it.brandId);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  });
  return map;
};

/**
 * Allocate an amount across weights proportionally using largest-remainder
 * so the parts always sum exactly to the amount (integer rupees).
 */
const allocateProportional = (amount, weights) => {
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  if (totalWeight === 0 || amount === 0) return weights.map(() => 0);

  const raw = weights.map((w) => (amount * w) / totalWeight);
  const floors = raw.map(Math.floor);
  let remainder = amount - floors.reduce((s, f) => s + f, 0);

  const order = raw
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac);
  const result = [...floors];
  for (let i = 0; i < order.length && remainder > 0; i += 1, remainder -= 1) {
    result[order[i].index] += 1;
  }
  return result;
};

module.exports = {
  ALLOWED_TRANSITIONS,
  canTransition,
  assertActorAllowed,
  TransitionError,
  transition,
  restoreStock,
  refundToCustomer,
  payoutVendor,
  reverseVendorPayout,
  syncGroupPaymentStatus,
  splitByBrand,
  allocateProportional,
};
