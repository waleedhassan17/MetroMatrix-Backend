const Product = require('../models/Product');
const Coupon = require('../models/Coupon');
const Order = require('../models/Order');
const OrderGroup = require('../models/OrderGroup');
const Address = require('../models/Address');
const WalletService = require('../../../services/walletService');
const cartService = require('./cartService');
const { splitByBrand, allocateProportional } = require('./orderService');
const { getShoppingSettings, resolveDeliveryTier } = require('./settingsService');

class CheckoutError extends Error {
  constructor(message, statusCode = 400, lines) {
    super(message);
    this.statusCode = statusCode;
    if (lines) this.lines = lines;
  }
}

/**
 * Checkout: Cart → OrderGroup → one Order per brand.
 *
 * NOTE ON ATOMICITY: multi-document transactions require a replica set and
 * are unreliable on the shared Atlas tier this project deploys to, so this
 * flow uses per-variant atomic $inc stock guards plus explicit compensating
 * rollback (restore stock, delete created docs) if a later step fails.
 */
const checkout = async (user, { addressId, shippingAddress, paymentMethod, deliveryOptionId }) => {
  if (!['wallet', 'cod'].includes(paymentMethod)) {
    throw new CheckoutError("paymentMethod must be 'wallet' or 'cod'");
  }

  // Resolve shipping address (saved or inline)
  let address = shippingAddress;
  if (addressId) {
    const saved = await Address.findOne({ _id: addressId, userId: user._id });
    if (!saved) throw new CheckoutError('Saved address not found', 404);
    address = saved.toJSON();
    if (!address.addressLine2 && (address.area || address.landmark)) {
      address.addressLine2 = [address.area, address.landmark].filter(Boolean).join(', ');
    }
  }
  const required = ['fullName', 'phone', 'addressLine1', 'city'];
  if (!address || required.some((f) => !address[f])) {
    throw new CheckoutError('A complete shipping address is required (fullName, phone, addressLine1, city)');
  }

  const cart = await cartService.getOrCreateCart(user._id);
  if (cart.items.length === 0) throw new CheckoutError('Your cart is empty');

  // (a) Re-validate every line against live product/brand/stock state
  const lineErrors = [];
  const lines = [];
  for (const item of cart.items) {
    const check = await cartService.validateLine(item.product, item.variantId, item.quantity);
    if (!check.ok) {
      const name = check.product ? check.product.name : `item ${item._id}`;
      lineErrors.push(`${name}: ${check.reason}`);
    } else {
      const variant = check.variant;
      const labelParts = [variant.size, variant.color].filter(Boolean);
      lines.push({
        productId: check.product._id,
        brandId: check.product.brandId,
        variantId: variant._id,
        productName: check.product.name,
        productImage: (check.product.images && check.product.images[0]) || '',
        variantLabel: labelParts.join(' / '),
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.unitPrice * item.quantity,
      });
    }
  }
  if (lineErrors.length) {
    throw new CheckoutError(`Some items are no longer available: ${lineErrors.join('; ')}`, 400, lineErrors);
  }

  // (b) Recompute all totals server-side — client totals are never trusted
  const settings = await getShoppingSettings();

  // Delivery speed. An unknown or disabled tier is rejected rather than
  // silently downgraded to standard: the shopper was shown a price for the
  // tier they picked, and charging a different one is the exact defect this
  // parameter exists to fix.
  let deliveryTier = null;
  if (deliveryOptionId) {
    deliveryTier = resolveDeliveryTier(settings, deliveryOptionId);
    if (!deliveryTier) {
      throw new CheckoutError('That delivery option is not available');
    }
  }
  const deliverySurcharge = deliveryTier ? deliveryTier.surcharge : 0;

  let discount = 0;
  let coupon = null;
  if (cart.appliedCoupon) {
    coupon = await Coupon.findOne({ couponCode: cart.appliedCoupon.toUpperCase() });
    const result = cartService.evaluateCoupon(coupon, lines);
    if (!result.ok) throw new CheckoutError(`Coupon problem: ${result.reason}`);
    discount = result.discount;
  }
  const totals = cartService.computeTotals(lines, discount, settings, deliverySurcharge);

  // (c) Wallet balance pre-check (fail before touching stock)
  let customerWallet = null;
  if (paymentMethod === 'wallet') {
    customerWallet = await WalletService.getOrCreateWallet(user._id, 'User');
    if (customerWallet.balance < totals.total) {
      throw new CheckoutError(
        `Insufficient wallet balance: you have PKR ${customerWallet.balance} but the order total is PKR ${totals.total}`
      );
    }
  }

  // (d) Atomically decrement stock with a guard — two concurrent checkouts
  // cannot oversell because the filter requires stockQuantity >= quantity.
  const decremented = [];
  try {
    for (const line of lines) {
      const result = await Product.updateOne(
        {
          _id: line.productId,
          variants: { $elemMatch: { _id: line.variantId, stockQuantity: { $gte: line.quantity } } },
        },
        { $inc: { 'variants.$.stockQuantity': -line.quantity } }
      );
      if (result.modifiedCount !== 1) {
        throw new CheckoutError(`${line.productName}: not enough stock (someone may have just bought it)`);
      }
      decremented.push(line);
    }

    // (e) Create the OrderGroup, then one Order per brand with proportional
    // discount and per-brand shipping (largest-remainder so sums reconcile)
    const byBrand = splitByBrand(lines);
    const brandKeys = [...byBrand.keys()];
    const brandSubtotals = brandKeys.map((k) =>
      byBrand.get(k).reduce((s, l) => s + l.totalPrice, 0)
    );
    let discountSplit;
    if (coupon && coupon.brandId) {
      // Brand-scoped coupon: entire discount lands on that brand's order
      discountSplit = brandKeys.map((k) => (String(coupon.brandId) === k ? discount : 0));
    } else {
      discountSplit = allocateProportional(discount, brandSubtotals);
    }
    const shippingPerBrand = brandKeys.map((k, i) =>
      brandSubtotals[i] >= settings.freeShippingThreshold ? 0 : settings.shippingFeePerBrand
    );
    // The speed surcharge is one charge for the whole group. Spread it over the
    // children with the same largest-remainder helper the discount uses, so the
    // children still sum to the group to the exact rupee.
    const surchargeSplit = allocateProportional(deliverySurcharge, brandSubtotals);

    const group = await OrderGroup.create({
      userId: user._id,
      orders: [],
      shippingAddress: address,
      paymentMethod,
      paymentStatus: 'pending',
      subtotal: totals.subtotal,
      discount: totals.discount,
      shippingFee: totals.shippingFee,
      total: totals.total,
      appliedCoupon: cart.appliedCoupon || null,
      deliveryOption: deliveryTier
        ? { id: deliveryTier.id, name: deliveryTier.name, surcharge: deliveryTier.surcharge }
        : null,
    });

    const orders = [];
    try {
      for (let i = 0; i < brandKeys.length; i += 1) {
        const brandLines = byBrand.get(brandKeys[i]);
        const order = await Order.create({
          orderGroup: group._id,
          userId: user._id,
          brandId: brandKeys[i],
          items: brandLines,
          shippingAddress: address,
          paymentMethod,
          paymentStatus: 'pending',
          orderStatus: 'pending',
          subtotal: brandSubtotals[i],
          discount: discountSplit[i],
          shippingFee: shippingPerBrand[i] + surchargeSplit[i],
          total: brandSubtotals[i] - discountSplit[i] + shippingPerBrand[i] + surchargeSplit[i],
          statusHistory: [
            { status: 'pending', changedBy: { id: user._id, role: 'customer' }, changedAt: new Date() },
          ],
        });
        orders.push(order);
      }

      // (f) Take payment through the ONE ledger primitive. payWithSettle()
      // owns the debit-plus-ledger-row pair and its compensating rollback,
      // so this path no longer hand-rolls a wallet mutation (WALLET_AUDIT.md
      // P1-1). The vendor is deliberately NOT credited here — that happens
      // at delivery via orderService.payoutVendor/settlePayout, so a
      // cancellation never has to claw back money the vendor already has.
      if (paymentMethod === 'wallet') {
        const { payerTransaction: txn } = await WalletService.payWithSettle({
          payerType: 'User',
          payerId: user._id,
          amount: totals.total,
          source: 'shopping_payment',
          relatedTo: { kind: 'OrderGroup', id: group._id },
          description: `Payment for order ${group.odexId}`,
          idempotencyKey: `shoppay-${group._id}`,
          metadata: { orderGroupId: String(group._id) },
        });
        group.walletTransactionId = txn._id;
        group.paymentStatus = 'paid';
        for (const order of orders) {
          order.paymentStatus = 'paid';
          await order.save();
        }
      }

      group.orders = orders.map((o) => o._id);
      await group.save();
    } catch (err) {
      // Compensating rollback of created documents. If the wallet was
      // already debited (payment succeeded but a later write — e.g.
      // group.save() — did not), give the money back BEFORE deleting the
      // group: otherwise the customer is charged for an order that no
      // longer exists, with only an orphaned ledger row to show for it.
      if (paymentMethod === 'wallet' && group.paymentStatus === 'paid') {
        await WalletService.refund({
          ownerType: 'User',
          ownerId: user._id,
          amount: totals.total,
          relatedTo: { kind: 'OrderGroup', id: group._id },
          description: `Reversal — checkout failed for order ${group.odexId}`,
          idempotencyKey: `shoprev-${group._id}`,
          metadata: { orderGroupId: String(group._id), reason: err.message },
        });
      }
      await Order.deleteMany({ orderGroup: group._id });
      await OrderGroup.deleteOne({ _id: group._id });
      throw err;
    }

    // (g) Clear cart, consume coupon
    cart.items = [];
    cart.appliedCoupon = null;
    await cart.save();
    if (coupon) {
      await Coupon.updateOne({ _id: coupon._id }, { $inc: { usedCount: 1 } });
    }

    // Refresh inStock flags for affected products
    const productIds = [...new Set(lines.map((l) => String(l.productId)))];
    for (const pid of productIds) {
      const product = await Product.findById(pid);
      if (product) {
        product.syncStockFlag();
        await product.save();
      }
    }

    return serializeGroup(group, orders);
  } catch (err) {
    // Compensating rollback of stock decrements
    for (const line of decremented) {
      await Product.updateOne(
        { _id: line.productId, 'variants._id': line.variantId },
        { $inc: { 'variants.$.stockQuantity': line.quantity } }
      );
    }
    throw err;
  }
};

/** OrderGroupView: group fields + fully serialized child orders. */
const serializeGroup = (group, orders) => {
  const json = group.toJSON();
  json.orders = orders.map((o) => (typeof o.toJSON === 'function' ? o.toJSON() : o));
  return json;
};

const loadGroupView = async (group) => {
  const orders = await Order.find({ orderGroup: group._id }).populate('brandId', 'name');
  return serializeGroup(group, orders);
};

module.exports = { checkout, CheckoutError, serializeGroup, loadGroupView };
