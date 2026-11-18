/**
 * Shopping history for one brand (Outfitters): orders across the window,
 * with exactly the side effects the real services produce —
 *   checkout (wallet)  -> customer debit  shopping_payment  (relatedTo OrderGroup)
 *   delivered          -> vendor credit   shopping_earning  (relatedTo Order) + vendorPayout
 *   cancelled (paid)   -> customer credit refund
 *   refunded           -> customer credit refund + vendor reversal debit
 * (checkoutService.js, orderService.js, WalletService.settlePayout/refund).
 *
 * Stock is not touched: historical orders are assumed restocked.
 */
const Order = require('../../../src/modules/shopping/models/Order');
const OrderGroup = require('../../../src/modules/shopping/models/OrderGroup');
const Product = require('../../../src/modules/shopping/models/Product');
const ProductReview = require('../../../src/modules/shopping/models/ProductReview');
const ReturnRequest = require('../../../src/modules/shopping/models/ReturnRequest');
const ShoppingNotification = require('../../../src/modules/shopping/models/ShoppingNotification');
const Address = require('../../../src/modules/shopping/models/Address');
const { makeRng, pickRepeat, pkt, hhmm, addMin, eachDayKey, weekdayOf, oidAt, shortHex, rupees, MIN, DAY } = require('./common');

const CHAIN = ['pending', 'confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered'];
const SHIPPING_FEE = 150; // settingsService defaults: 150 per brand, free from 3000
const FREE_SHIPPING_FROM = 3000;
const CARRIERS = ['TCS', 'Leopards', 'M&P'];

const FALLBACK_ADDRESSES = [
  ['House 14, Street 3, Gulberg III', 'Gulberg III'],
  ['House 221, Block J, Johar Town', 'Johar Town'],
  ['House 9, Y-Block, DHA Phase 3', 'DHA Phase 3'],
  ['House 41, Block C, Model Town', 'Model Town'],
  ['Flat 6, Askari 11, Bedian Road', 'Askari 11'],
  ['House 77, Sector C, Bahria Town', 'Bahria Town'],
  ['House 18, Block B, Faisal Town', 'Faisal Town'],
  ['House 3, Wapda Town Phase 1', 'Wapda Town'],
];

const REVIEW_TEMPLATES = {
  5: [
    ['Perfect fit', 'Fits exactly as the size chart says and the fabric feels premium.'],
    ['Love it', 'Exactly like the pictures. Delivery was quicker than expected.'],
    ['Great quality', 'Third order from Outfitters and the quality is consistently good.'],
    ['Highly recommend', 'Comfortable, well stitched and the colour has not faded after washing.'],
  ],
  4: [
    ['Good buy', 'Nice material, runs slightly large — order one size down.'],
    ['Pretty good', 'Good quality for the price. Packaging could be better.'],
    ['Happy with it', 'Looks great, delivery took a day longer than promised.'],
  ],
  3: [
    ['Okay', 'Decent but the colour is a shade lighter than on the website.'],
    ['Average', 'Fine for everyday wear, nothing special.'],
  ],
  2: [['Not great', 'Stitching on the sleeve came loose after two washes.']],
  1: [['Disappointed', 'Received the wrong size and the exchange took too long.']],
};
const VENDOR_RESPONSES = [
  'Thank you for shopping with Outfitters! We are glad you liked it.',
  'Thanks for the feedback — we have shared the sizing note with our product team.',
  'Sorry about this. Please reach out to our support team and we will make it right.',
];
const RETURN_REASONS = ['Size too small', 'Size too large', 'Colour different from pictures', 'Received a defective piece'];

/** What the customer hears for each step (orderNotifications.customerMessageFor). */
function customerMessage(status, ref, order, actorRole) {
  switch (status) {
    case 'confirmed':
      return { title: 'Order confirmed', message: `${ref} is confirmed and being prepared.` };
    case 'shipped':
      return { title: 'Your order is on its way', message: `${ref} has shipped (tracking ${order.trackingNumber}).` };
    case 'out_for_delivery':
      return { title: 'Out for delivery', message: `${ref} will reach you today.` };
    case 'delivered':
      return { title: 'Delivered', message: `${ref} was delivered. Enjoy — and leave a review?` };
    case 'cancelled':
      if (actorRole === 'customer') return null;
      return {
        title: 'Order cancelled',
        message: `${ref} was cancelled by the store${order.paymentMethod === 'wallet' ? `; ${rupees(order.total)} is refunded to your wallet` : ''}.`,
        type: 'order_cancelled',
      };
    case 'returned':
      return { title: 'Return accepted', message: `The store accepted your return for ${ref}.` };
    case 'refunded':
      return { title: 'Refund issued', message: `${rupees(order.total)} for ${ref} is back in your wallet.` };
    default:
      return null;
  }
}

function statusByAge(rng, ageDays) {
  if (ageDays >= 8) return rng.weighted([['delivered', 86], ['cancelled', 9], ['refunded', 5]]);
  if (ageDays >= 5) return rng.weighted([['delivered', 80], ['out_for_delivery', 7], ['shipped', 7], ['cancelled', 6]]);
  if (ageDays >= 3) return rng.weighted([['delivered', 35], ['shipped', 35], ['processing', 15], ['out_for_delivery', 7], ['cancelled', 8]]);
  if (ageDays >= 1) return rng.weighted([['confirmed', 30], ['processing', 35], ['shipped', 20], ['pending', 5], ['cancelled', 10]]);
  return rng.weighted([['pending', 55], ['confirmed', 45]]);
}

/**
 * The order's status trail, ending at `target`, with realistic gaps. If the
 * trail would run past `now`, the gaps are compressed so it still ends in the
 * past (an order aged 3 days can still have been delivered).
 */
function buildTimeline(rng, placedAt, target, now, cancelBy) {
  const steps = [{ status: 'pending', at: placedAt, by: 'customer' }];
  let t = placedAt;
  const push = (status, gapMin, by = 'vendor') => {
    t = addMin(t, gapMin);
    steps.push({ status, at: t, by });
  };
  const GAPS = { confirmed: [40, 360], processing: [240, 1200], shipped: [300, 1500], out_for_delivery: [900, 2400], delivered: [120, 540] };

  if (target === 'cancelled') {
    if (rng.chance(0.5)) push('confirmed', rng.int(...GAPS.confirmed));
    push('cancelled', rng.int(30, 600), cancelBy);
  } else {
    const end = ['returned', 'refunded'].includes(target) ? 'delivered' : target;
    for (const status of CHAIN.slice(1, CHAIN.indexOf(end) + 1)) push(status, rng.int(...GAPS[status]));
    if (['returned', 'refunded'].includes(target)) {
      push('returned', rng.int(2 * 1440, 4 * 1440));
      if (target === 'refunded') push('refunded', rng.int(1 * 1440, 2 * 1440));
    }
  }

  const latest = now.getTime() - rng.int(30, 300) * MIN;
  const last = steps[steps.length - 1].at.getTime();
  if (last > latest && steps.length > 1) {
    const factor = (latest - placedAt.getTime()) / (last - placedAt.getTime());
    if (factor > 0.02) {
      steps.forEach((s) => {
        s.at = new Date(placedAt.getTime() + (s.at.getTime() - placedAt.getTime()) * factor);
      });
    } else {
      while (steps.length > 1 && steps[steps.length - 1].at.getTime() > now.getTime()) steps.pop();
    }
  }
  return steps;
}

async function shippingAddressFor(user, rng) {
  const saved = await Address.findOne({ userId: user._id }).sort({ isDefault: -1 }).lean();
  if (saved) {
    return {
      fullName: saved.fullName || user.fullName,
      phone: saved.phone || user.phoneNumber || '03001234567',
      addressLine1: saved.addressLine1 || saved.area || 'Lahore',
      addressLine2: saved.addressLine2 || undefined,
      city: saved.city || 'Lahore',
      state: saved.state || 'Punjab',
      postalCode: saved.postalCode || '',
      country: 'Pakistan',
    };
  }
  const [line1] = rng.pick(FALLBACK_ADDRESSES);
  return {
    fullName: user.fullName,
    phone: user.phoneNumber || '03001234567',
    addressLine1: line1,
    city: 'Lahore',
    state: 'Punjab',
    postalCode: '',
    country: 'Pakistan',
  };
}

function pickLines(rng, products, count) {
  const lines = [];
  const used = new Set();
  for (let i = 0; i < count && used.size < products.length; i += 1) {
    let product = rng.pick(products);
    while (used.has(String(product._id))) product = rng.pick(products);
    used.add(String(product._id));
    const variant = rng.pick(product.variants);
    lines.push({ product, variant, qty: rng.chance(0.85) ? 1 : 2 });
  }
  return lines;
}

async function seedOrder(ctx, env, spec) {
  const { now } = ctx;
  const { brand, vendor, vendorWallet } = env;
  const { key, user, rng, placedAt, payment, target, lines, notifyCustomer } = spec;
  if (ctx.has(`${key}:order`)) {
    ctx.count('shoppingorders', 'skipped');
    return null;
  }

  const items = lines.map(({ product, variant, qty }) => {
    const unitPrice = (product.salePrice ?? product.basePrice) + (variant.additionalPrice || 0);
    return {
      productId: product._id,
      brandId: brand._id,
      variantId: variant._id,
      productName: product.name,
      productImage: (product.images && product.images[0]) || '',
      variantLabel: [variant.size, variant.color].filter(Boolean).join(' / '),
      quantity: qty,
      unitPrice,
      totalPrice: unitPrice * qty,
    };
  });
  const subtotal = items.reduce((s, it) => s + it.totalPrice, 0);
  const shippingFee = subtotal >= FREE_SHIPPING_FROM ? 0 : SHIPPING_FEE;
  const total = subtotal + shippingFee;

  const cancelBy = spec.cancelBy || (rng.chance(0.6) ? 'customer' : 'vendor');
  const steps = buildTimeline(rng, placedAt, target, now, cancelBy);
  const reached = steps.map((s) => s.status);
  const finalStatus = reached[reached.length - 1];
  const at = (status) => (steps.find((s) => s.status === status) || {}).at || null;
  const deliveredAt = at('delivered');
  const refunded = finalStatus === 'refunded';
  const cancelled = finalStatus === 'cancelled';

  let paymentStatus;
  if (payment === 'wallet') paymentStatus = cancelled || refunded ? 'refunded' : 'paid';
  else paymentStatus = refunded ? 'refunded' : deliveredAt ? 'paid' : 'pending';

  const shippingAddress = await shippingAddressFor(user, rng);
  const shipped = reached.includes('shipped');
  const trackingNumber = shipped ? `${rng.pick(['TCS', 'LCS', 'MNP'])}-${29800000 + rng.int(0, 99999)}` : null;
  const lastAt = steps[steps.length - 1].at;

  const groupId = oidAt(placedAt);
  const orderId = oidAt(placedAt);
  const payTxnId = payment === 'wallet' ? oidAt(placedAt) : null;
  const earnTxnId = deliveredAt ? oidAt(deliveredAt) : null;

  const actorId = (by) => (by === 'customer' ? user._id : vendor._id);
  const orderDoc = {
    _id: orderId,
    orderGroup: groupId,
    userId: user._id,
    brandId: brand._id,
    items,
    shippingAddress,
    paymentMethod: payment,
    paymentStatus,
    orderStatus: finalStatus,
    trackingNumber,
    carrier: shipped ? rng.pick(CARRIERS) : '',
    subtotal,
    discount: 0,
    shippingFee,
    total,
    statusHistory: steps.map((s) => ({
      status: s.status,
      changedBy: { id: actorId(s.by), role: s.by },
      changedAt: s.at,
    })),
    deliveredAt,
    vendorPayout: deliveredAt
      ? { amount: total, commission: 0, paidAt: refunded ? null : deliveredAt, walletTransactionId: earnTxnId }
      : undefined,
    createdAt: placedAt,
    updatedAt: lastAt,
  };
  await new Order(orderDoc).validate(); // fail before writing anything

  const group = await ctx.put(OrderGroup, `${key}:group`, {
    _id: groupId,
    userId: user._id,
    orders: [orderId],
    shippingAddress,
    paymentMethod: payment,
    paymentStatus,
    subtotal,
    discount: 0,
    shippingFee,
    total,
    walletTransactionId: payTxnId,
    createdAt: placedAt,
    updatedAt: lastAt,
  });
  const order = await ctx.put(Order, `${key}:order`, orderDoc);
  const odexId = order.doc ? order.doc.odexId : '';
  const groupOdex = group.doc ? group.doc.odexId : '';

  // Ledger
  const customerWallet = await ctx.wallet(user._id, 'User', spec.walletLabel || user.email);
  if (payment === 'wallet') {
    await ctx.customerDebit(`${key}:pay`, customerWallet, {
      _id: payTxnId,
      amount: total,
      source: 'shopping_payment',
      description: `Payment for order ${groupOdex}`,
      relatedTo: { kind: 'OrderGroup', id: groupId },
      metadata: { orderGroupId: String(groupId) },
      at: placedAt,
    });
  }
  if (deliveredAt) {
    await ctx.ledger(`${key}:earn`, vendorWallet, {
      _id: earnTxnId,
      type: 'credit',
      amount: total,
      source: 'shopping_earning',
      description: `Earnings for order ${odexId}`,
      relatedTo: { kind: 'Order', id: orderId },
      transferGroupId: `payout_${shortHex(8)}`,
      metadata: { grossAmount: total, commission: 0, commissionRate: 0 },
      at: deliveredAt,
    });
  }
  if (cancelled && payment === 'wallet') {
    await ctx.ledger(`${key}:refund`, customerWallet, {
      type: 'credit',
      amount: total,
      source: 'refund',
      description: `Refund for cancelled order ${odexId}`,
      relatedTo: { kind: 'Order', id: orderId },
      metadata: { shoppingOrderId: String(orderId), orderGroupId: String(groupId) },
      at: at('cancelled'),
    });
  }
  if (refunded) {
    await ctx.ledger(`${key}:refund`, customerWallet, {
      type: 'credit',
      amount: total,
      source: 'refund',
      description: `Refund for returned order ${odexId}`,
      relatedTo: { kind: 'Order', id: orderId },
      metadata: { shoppingOrderId: String(orderId), orderGroupId: String(groupId) },
      at: at('refunded'),
    });
    await ctx.ledger(`${key}:reverse`, vendorWallet, {
      type: 'debit',
      amount: total,
      source: 'refund',
      description: `Reversal of earnings for Order ${orderId}`,
      relatedTo: { kind: 'Order', id: orderId },
      metadata: { reversedTransactionId: String(earnTxnId) },
      at: addMin(at('refunded'), 1),
    });
  }

  // Return request behind a returned/refunded order
  if (reached.includes('returned') && order.doc) {
    const requestedAt = addMin(deliveredAt, rng.int(1 * 1440, 2 * 1440));
    const returned = order.doc.items.slice(0, 1);
    await ctx.put(ReturnRequest, `${key}:return`, {
      order: orderId,
      userId: user._id,
      brandId: brand._id,
      items: returned.map((it) => ({
        orderItemId: it._id,
        productId: it.productId,
        productName: it.productName,
        variantId: it.variantId,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
      })),
      reason: rng.pick(RETURN_REASONS),
      status: refunded ? 'refunded' : 'picked_up',
      vendorNote: 'Return approved — courier pickup arranged.',
      refundAmount: returned.reduce((s, it) => s + it.unitPrice * it.quantity, 0),
      createdAt: requestedAt,
      updatedAt: at(refunded ? 'refunded' : 'returned'),
    });
  }

  // Review on a delivered order
  if (finalStatus === 'delivered' && spec.review && order.doc) {
    const reviewAt = addMin(deliveredAt, rng.int(6 * 60, 4 * 1440));
    if (reviewAt < now) {
      const rating = spec.review;
      const [title, comment] = rng.pick(REVIEW_TEMPLATES[rating]);
      const item = order.doc.items[0];
      await ctx.put(ProductReview, `${key}:review`, {
        productId: item.productId,
        brandId: brand._id,
        userId: user._id,
        order: orderId,
        rating,
        title,
        comment,
        isVerifiedPurchase: true,
        vendorResponse: rng.chance(rating <= 3 ? 0.8 : 0.25) ? VENDOR_RESPONSES[rating <= 3 ? 2 : rng.int(0, 1)] : '',
        createdAt: reviewAt,
      });
      env.touchedProducts.add(String(item.productId));
    }
  }

  // Notifications: the customer's inbox (Ubaid), and the vendor's for the last 14 days
  const ref = odexId;
  const notifData = { orderId: String(orderId), odexId, status: finalStatus };
  const readIf = (when, hours) => {
    const isRead = now.getTime() - when.getTime() > hours * 3600000;
    return { isRead, readAt: isRead ? addMin(when, 25) : null };
  };
  let n = 0;
  const notify = async (doc) => {
    n += 1;
    await ctx.put(ShoppingNotification, `${key}:n:${n}`, doc);
  };
  if (notifyCustomer) {
    await notify({
      recipient: user._id,
      recipientRole: 'user',
      type: 'order_placed',
      title: 'Order placed',
      message: `${ref} from ${brand.name} — ${rupees(total)}.`,
      data: notifData,
      createdAt: placedAt,
      ...readIf(placedAt, 48),
    });
    for (const s of steps.slice(1)) {
      const c = customerMessage(s.status, ref, { ...orderDoc, odexId }, s.by);
      if (!c) continue;
      await notify({
        recipient: user._id,
        recipientRole: 'user',
        type: c.type || 'order_update',
        title: c.title,
        message: c.message,
        data: notifData,
        createdAt: s.at,
        ...readIf(s.at, 48),
      });
    }
  }
  if (now.getTime() - placedAt.getTime() < 14 * DAY) {
    const units = items.reduce((s, it) => s + it.quantity, 0);
    await notify({
      recipient: vendor._id,
      recipientRole: 'vendor',
      type: 'order_created',
      title: 'New order',
      message: `${ref}: ${units} item${units === 1 ? '' : 's'}, ${rupees(total)} (${payment === 'cod' ? 'cash on delivery' : 'paid'}).`,
      data: notifData,
      createdAt: placedAt,
      ...readIf(placedAt, 24),
    });
    if (cancelled && cancelBy === 'customer') {
      await notify({
        recipient: vendor._id,
        recipientRole: 'vendor',
        type: 'order_cancelled',
        title: 'Order cancelled',
        message: `${ref} was cancelled by the customer.`,
        data: notifData,
        createdAt: at('cancelled'),
        ...readIf(at('cancelled'), 24),
      });
    }
  }
  return { finalStatus, total };
}

// Ubaid's own Outfitters history.
const PRIMARY_ORDERS = [
  { day: '2026-08-21', time: '21:14', payment: 'wallet', target: 'delivered', review: 5, lines: 2 },
  { day: '2026-08-30', time: '13:40', payment: 'cod', target: 'delivered', lines: 1 },
  { day: '2026-09-09', time: '22:05', payment: 'wallet', target: 'delivered', review: 4, lines: 3 },
  { day: '2026-09-20', time: '11:25', payment: 'wallet', target: 'cancelled', cancelBy: 'customer', lines: 1 },
  { day: '2026-09-28', time: '20:30', payment: 'wallet', target: 'delivered', lines: 2 },
  { day: '2026-10-07', time: '23:10', payment: 'wallet', target: 'refunded', lines: 1 },
  { day: '2026-10-18', time: '16:45', payment: 'cod', target: 'delivered', review: 5, lines: 2 },
  { day: '2026-10-26', time: '19:20', payment: 'wallet', target: 'delivered', lines: 1 },
  { day: '2026-11-06', time: '21:50', payment: 'wallet', target: 'delivered', review: 4, lines: 2 },
  { day: '2026-11-15', time: '18:05', payment: 'wallet', target: 'out_for_delivery', lines: 1 },
];

async function seedShopping(ctx, { primary, vendor, brand, others, fromKey, toKey }) {
  const products = (
    await Product.find({
      brandId: brand._id,
      isActive: true,
      'moderation.status': { $nin: ['rejected', 'removed', 'pending'] },
    }).lean()
  ).filter((p) => Array.isArray(p.variants) && p.variants.length);
  if (!products.length) throw new Error('Outfitters has no active products — run npm run seed:shopping first.');

  const env = {
    brand,
    vendor,
    vendorWallet: await ctx.wallet(vendor._id, 'Provider', 'Outfitters (vendor)'),
    touchedProducts: new Set(),
  };
  const summary = { primary: 0, others: 0 };

  for (let i = 0; i < PRIMARY_ORDERS.length; i += 1) {
    const plan = PRIMARY_ORDERS[i];
    const key = `shop:primary:${String(i + 1).padStart(2, '0')}`;
    const rng = makeRng(key);
    const placedAt = pkt(plan.day, plan.time);
    if (placedAt > ctx.now) continue;
    const res = await seedOrder(ctx, env, {
      key,
      user: primary,
      rng,
      placedAt,
      payment: plan.payment,
      target: plan.target,
      cancelBy: plan.cancelBy,
      review: plan.review,
      lines: pickLines(rng, products, plan.lines),
      notifyCustomer: true,
      walletLabel: 'Ubaid (customer)',
    });
    if (res) summary.primary += 1;
  }

  const days = eachDayKey(fromKey, toKey);
  for (let d = 0; d < days.length; d += 1) {
    const day = days[d];
    const progress = days.length > 1 ? d / (days.length - 1) : 1;
    const dayRng = makeRng(`shop:day:${day}`);
    const lambda = (0.45 + 0.7 * progress) * (weekdayOf(day) >= 6 ? 1.35 : 1);
    const count = Math.floor(lambda + dayRng.next());
    for (let i = 0; i < count; i += 1) {
      const key = `shop:o:${day}:${i}`;
      const rng = makeRng(key);
      const placedAt = pkt(day, hhmm(rng.int(10 * 60, 23 * 60 + 30)));
      if (placedAt.getTime() > ctx.now.getTime() - 20 * MIN) continue;
      const ageDays = (ctx.now.getTime() - placedAt.getTime()) / DAY;
      const target = statusByAge(rng, ageDays);
      const lineCount = rng.weighted([[1, 60], [2, 30], [3, 10]]);
      const res = await seedOrder(ctx, env, {
        key,
        user: pickRepeat(rng, others),
        rng,
        placedAt,
        payment: rng.chance(0.65) ? 'wallet' : 'cod',
        target,
        review: rng.chance(0.4) ? rng.weighted([[5, 45], [4, 33], [3, 13], [2, 6], [1, 3]]) : null,
        lines: pickLines(rng, products, lineCount),
        notifyCustomer: false,
      });
      if (res) summary.others += 1;
    }
  }

  // Product rating/totalReviews from every review the product has.
  if (!ctx.dryRun && env.touchedProducts.size) await recomputeProductRatings([...env.touchedProducts]);
  return summary;
}

async function recomputeProductRatings(productIds) {
  const mongoose = require('mongoose');
  const ids = productIds.map((id) => new mongoose.Types.ObjectId(String(id)));
  const aggs = await ProductReview.aggregate([
    { $match: { productId: { $in: ids } } },
    { $group: { _id: '$productId', avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  const byId = new Map(aggs.map((a) => [String(a._id), a]));
  for (const id of ids) {
    const a = byId.get(String(id));
    await Product.collection.updateOne(
      { _id: id },
      { $set: { rating: a ? Math.round(a.avg * 10) / 10 : 0, totalReviews: a ? a.count : 0 } }
    );
  }
}

module.exports = { seedShopping, recomputeProductRatings };
