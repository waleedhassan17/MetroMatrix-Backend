/**
 * Telling customers and vendors what happened to an order.
 *
 * Every function is best-effort and never throws: the order transition, the
 * checkout or the return request has already been saved, and a failed
 * notification must not turn a success into an error. Each event writes the
 * inbox row (ShoppingNotification) and pushes through the realtime service
 * (sockets.pushToUser → Expo → FCM) — customers' devices are on User,
 * vendors' on Provider (the brand owner).
 */
const ShoppingNotification = require('../models/ShoppingNotification');
const Brand = require('../models/Brand');

const rupees = (n) => `Rs. ${Math.round(Number(n) || 0).toLocaleString('en-PK')}`;

/** What the CUSTOMER hears when their order moves (null = nothing worth a push). */
function customerMessageFor(order, next, actor) {
  const ref = order.odexId || 'your order';
  switch (next) {
    case 'confirmed':
      return { title: 'Order confirmed', message: `${ref} is confirmed and being prepared.` };
    case 'shipped':
      return {
        title: 'Your order is on its way',
        message: `${ref} has shipped${order.trackingNumber ? ` (tracking ${order.trackingNumber})` : ''}.`,
      };
    case 'out_for_delivery':
      return { title: 'Out for delivery', message: `${ref} will reach you today.` };
    case 'delivered':
      return { title: 'Delivered', message: `${ref} was delivered. Enjoy — and leave a review?` };
    case 'cancelled':
      if (actor.role === 'customer') return null; // they did it
      return {
        title: 'Order cancelled',
        message: `${ref} was cancelled by the ${actor.role === 'admin' ? 'MetroMatrix team' : 'store'}${
          order.paymentStatus === 'paid' ? `; ${rupees(order.total)} is refunded to your wallet` : ''
        }.`,
        type: 'order_cancelled',
      };
    case 'returned':
      return { title: 'Return accepted', message: `The store accepted your return for ${ref}.` };
    case 'refunded':
      return { title: 'Refund issued', message: `${rupees(order.total)} for ${ref} is back in your wallet.` };
    default:
      return null; // pending / processing: internal steps
  }
}

/** What the VENDOR hears (null = nothing). */
function vendorMessageFor(order, next, actor) {
  const ref = order.odexId || 'an order';
  if (next === 'cancelled' && actor.role !== 'vendor') {
    return {
      title: 'Order cancelled',
      message: `${ref} was cancelled by the ${actor.role === 'admin' ? 'MetroMatrix team' : 'customer'}.`,
      type: 'order_cancelled',
    };
  }
  if (next === 'delivered' && actor.role !== 'vendor') {
    return { title: 'Order delivered', message: `${ref} was marked delivered; your payout is credited.` };
  }
  return null;
}

async function ownerOf(brandId) {
  if (!brandId) return null;
  const brand = await Brand.findById(brandId).select('owner name').lean();
  return brand && brand.owner ? { ownerId: brand.owner, brandName: brand.name } : null;
}

async function deliver({ recipient, recipientRole, type, title, message, data, pushType }) {
  if (!recipient) return;
  const { pushToUser } = require('../../../sockets');
  const results = await Promise.allSettled([
    ShoppingNotification.create({ recipient, recipientRole, type, title, message, data }),
    pushType
      ? pushToUser(recipient, recipientRole === 'vendor' ? 'provider' : 'user', {
          type: pushType,
          title,
          body: message,
          data: { ...data, roomType: 'shopping', audience: recipientRole === 'vendor' ? 'vendor' : 'customer' },
        })
      : Promise.resolve(false),
  ]);
  results.forEach((r) => {
    if (r.status === 'rejected') console.error(`[shop-notify] ${type} failed: ${r.reason && r.reason.message}`);
  });
}

/** After orderService.transition has saved `order` in `next`. */
async function announceOrderTransition(order, next, actor = {}) {
  try {
    const data = { orderId: String(order._id), odexId: order.odexId, status: next };
    const tasks = [];
    const c = customerMessageFor(order, next, actor);
    if (c) {
      tasks.push(
        deliver({
          recipient: order.userId,
          recipientRole: 'user',
          type: c.type || 'order_update',
          title: c.title,
          message: c.message,
          data,
          pushType: 'order_update',
        })
      );
    }
    const v = vendorMessageFor(order, next, actor);
    if (v) {
      const owner = await ownerOf(order.brandId);
      if (owner) {
        tasks.push(
          deliver({
            recipient: owner.ownerId,
            recipientRole: 'vendor',
            type: v.type || 'order_update',
            title: v.title,
            message: v.message,
            data,
            pushType: 'order_update',
          })
        );
      }
    }
    await Promise.allSettled(tasks);
  } catch (e) {
    console.error(`[shop-notify] transition order=${order && order._id}: ${e.message}`);
  }
}

/** After checkout: each brand's owner hears about their order; the customer gets an inbox receipt. */
async function announceOrdersPlaced(orders, user) {
  try {
    const tasks = [];
    for (const order of orders) {
      const owner = await ownerOf(order.brandId);
      const items = (order.items || []).reduce((n, it) => n + (it.quantity || 0), 0);
      const data = { orderId: String(order._id), odexId: order.odexId, status: order.orderStatus };
      if (owner) {
        tasks.push(
          deliver({
            recipient: owner.ownerId,
            recipientRole: 'vendor',
            type: 'order_created',
            title: 'New order',
            message: `${order.odexId}: ${items} item${items === 1 ? '' : 's'}, ${rupees(order.total)} (${
              order.paymentMethod === 'cod' ? 'cash on delivery' : 'paid'
            }).`,
            data,
            pushType: 'order_created',
          })
        );
      }
      tasks.push(
        deliver({
          recipient: user._id,
          recipientRole: 'user',
          type: 'order_placed',
          title: 'Order placed',
          message: `${order.odexId}${owner && owner.brandName ? ` from ${owner.brandName}` : ''} — ${rupees(order.total)}.`,
          data,
          pushType: null, // they are looking at the confirmation screen
        })
      );
    }
    await Promise.allSettled(tasks);
  } catch (e) {
    console.error(`[shop-notify] orders placed: ${e.message}`);
  }
}

/** A customer asked to return items — tell the vendor. */
async function announceReturnRequested(request, order) {
  try {
    const owner = await ownerOf(order.brandId);
    if (!owner) return;
    await deliver({
      recipient: owner.ownerId,
      recipientRole: 'vendor',
      type: 'return_requested',
      title: 'Return requested',
      message: `A customer asked to return items from ${order.odexId} (${rupees(request.refundAmount)}).`,
      data: { orderId: String(order._id), odexId: order.odexId, returnId: String(request._id) },
      pushType: 'return_update',
    });
  } catch (e) {
    console.error(`[shop-notify] return order=${order && order._id}: ${e.message}`);
  }
}

module.exports = {
  announceOrderTransition,
  announceOrdersPlaced,
  announceReturnRequested,
  customerMessageFor,
  vendorMessageFor,
  deliver,
};
