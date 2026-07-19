const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const OrderGroup = require('../models/OrderGroup');
const Brand = require('../models/Brand');
const ReturnRequest = require('../models/ReturnRequest');
const checkoutService = require('../services/checkoutService');
const orderService = require('../services/orderService');
const { ok, paginated, fail, parsePagination } = require('../utils/respond');

const isCastError = (e) =>
  e.name === 'CastError' || e.name === 'BSONError' || e.name === 'BSONTypeError';

// @desc  POST /api/shopping/checkout
const postCheckout = asyncHandler(async (req, res) => {
  try {
    const view = await checkoutService.checkout(req.user, {
      addressId: req.body.addressId,
      shippingAddress: req.body.shippingAddress,
      paymentMethod: req.body.paymentMethod,
    });
    return ok(res, view, 201);
  } catch (e) {
    if (e.statusCode) return fail(res, e.statusCode, e.message, e.lines);
    throw e;
  }
});

// @desc  GET /api/shopping/orders — my order groups, filter by child status
const getMyOrders = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = { userId: req.user._id };

  if (req.query.status) {
    const groupIds = await Order.distinct('orderGroup', {
      userId: req.user._id,
      orderStatus: req.query.status,
    });
    filter._id = { $in: groupIds };
  }

  const [groups, total] = await Promise.all([
    OrderGroup.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    OrderGroup.countDocuments(filter),
  ]);
  const data = [];
  for (const group of groups) {
    data.push(await checkoutService.loadGroupView(group));
  }
  return paginated(res, { data, page, limit, total });
});

// @desc  GET /api/shopping/orders/:id — accepts a groupId OR a child orderId
const getOrderById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return fail(res, 400, 'Invalid order ID');

  let group = await OrderGroup.findOne({ _id: id, userId: req.user._id });
  if (!group) {
    const child = await Order.findOne({ _id: id, userId: req.user._id });
    if (child) group = await OrderGroup.findOne({ _id: child.orderGroup });
  }
  if (!group) return fail(res, 404, 'Order not found');
  return ok(res, await checkoutService.loadGroupView(group));
});

// @desc  GET /api/shopping/orders/:orderId/tracking
const getOrderTracking = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  if (!mongoose.isValidObjectId(orderId)) return fail(res, 400, 'Invalid order ID');
  const order = await Order.findOne({ _id: orderId, userId: req.user._id });
  if (!order) return fail(res, 404, 'Order not found');
  return ok(res, {
    orderId: String(order._id),
    odexId: order.odexId,
    orderStatus: order.orderStatus,
    trackingNumber: order.trackingNumber || undefined,
    statusHistory: order.statusHistory.map((h) => ({
      status: h.status,
      changedAt: h.changedAt,
      note: h.note || undefined,
      role: h.changedBy ? h.changedBy.role : undefined,
    })),
  });
});

// @desc  POST /api/shopping/orders/:orderId/cancel { reason }
const cancelOrder = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  if (!mongoose.isValidObjectId(orderId)) return fail(res, 400, 'Invalid order ID');
  const order = await Order.findOne({ _id: orderId, userId: req.user._id });
  if (!order) return fail(res, 404, 'Order not found');
  try {
    await orderService.transition(order, 'cancelled', { id: req.user._id, role: 'customer' }, {
      note: req.body.reason || 'Cancelled by customer',
    });
  } catch (e) {
    if (e.statusCode) return fail(res, e.statusCode, e.message);
    throw e;
  }
  await order.populate('brandId', 'name');
  return ok(res, order);
});

// @desc  POST /api/shopping/orders/:orderId/return { items[], reason, images[] }
const requestReturn = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  if (!mongoose.isValidObjectId(orderId)) return fail(res, 400, 'Invalid order ID');
  const order = await Order.findOne({ _id: orderId, userId: req.user._id });
  if (!order) return fail(res, 404, 'Order not found');

  if (order.orderStatus !== 'delivered') {
    return fail(res, 400, 'Only delivered orders can be returned');
  }

  // Enforce the brand's return window from the delivered date
  const brand = await Brand.findById(order.brandId);
  const returnDays = brand && brand.policies ? brand.policies.returnDays : 7;
  const deliveredAt = order.deliveredAt || order.updatedAt;
  const windowEnd = new Date(deliveredAt.getTime() + returnDays * 24 * 60 * 60 * 1000);
  if (new Date() > windowEnd) {
    return fail(res, 400, `The ${returnDays}-day return window for this order has closed`);
  }

  const existing = await ReturnRequest.findOne({
    order: order._id,
    status: { $in: ['requested', 'approved', 'picked_up'] },
  });
  if (existing) return fail(res, 400, 'A return request for this order is already open');

  if (!req.body.reason) return fail(res, 400, 'A return reason is required');

  // Default to all lines when no explicit item subset is sent
  let items = order.items.map((it) => ({
    orderItemId: it._id,
    productId: it.productId,
    productName: it.productName,
    variantId: it.variantId,
    quantity: it.quantity,
    unitPrice: it.unitPrice,
  }));
  if (Array.isArray(req.body.items) && req.body.items.length > 0) {
    const wanted = new Set(req.body.items.map((i) => String(i.itemId || i.orderItemId || i)));
    items = items.filter((it) => wanted.has(String(it.orderItemId)));
    if (items.length === 0) return fail(res, 400, 'No matching order items to return');
  }

  const request = await ReturnRequest.create({
    order: order._id,
    userId: req.user._id,
    brandId: order.brandId,
    items,
    reason: req.body.reason,
    images: Array.isArray(req.body.images) ? req.body.images : [],
    refundAmount: items.reduce((s, it) => s + it.unitPrice * it.quantity, 0),
  });
  return ok(res, request, 201);
});

// @desc  GET /api/shopping/returns — my return requests
const getMyReturns = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = { userId: req.user._id };
  const [rows, total] = await Promise.all([
    ReturnRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    ReturnRequest.countDocuments(filter),
  ]);
  return paginated(res, { data: rows, page, limit, total });
});

module.exports = {
  postCheckout,
  getMyOrders,
  getOrderById,
  getOrderTracking,
  cancelOrder,
  requestReturn,
  getMyReturns,
};
