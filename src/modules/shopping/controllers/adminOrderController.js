const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const OrderGroup = require('../models/OrderGroup');
const Brand = require('../models/Brand');
const Product = require('../models/Product');
const ReturnRequest = require('../models/ReturnRequest');
const User = require('../../../models/User');
const orderService = require('../services/orderService');
const { audit } = require('../middleware/adminAuth');
const { getShoppingSettings, updateShoppingSettings } = require('../services/settingsService');
const { escapeRegex } = require('../services/catalogService');
const { ok, paginated, fail, parsePagination } = require('../utils/respond');

/**
 * ── Order oversight ────────────────────────────────────────────────
 */

// @desc  GET /api/shopping/admin/orders?brandId&status&paymentStatus&from&to&search&page&limit
const listAllOrders = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};
  if (req.query.brandId) filter.brandId = req.query.brandId;
  if (req.query.status) filter.orderStatus = req.query.status;
  if (req.query.paymentStatus) filter.paymentStatus = req.query.paymentStatus;
  if (req.query.from || req.query.to) {
    filter.createdAt = {};
    if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
    if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
  }
  if (req.query.search) {
    const rx = new RegExp(escapeRegex(req.query.search), 'i');
    const users = await User.find({ $or: [{ name: rx }, { email: rx }] }).select('_id');
    filter.$or = [{ odexId: rx }, { userId: { $in: users.map((u) => u._id) } }];
  }

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .populate('brandId', 'name')
      .populate('userId', 'name fullName email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Order.countDocuments(filter),
  ]);
  const data = orders.map((o) => {
    const json = o.toJSON();
    if (o.brandId && typeof o.brandId === 'object') json.brandName = o.brandId.name;
    if (o.userId && typeof o.userId === 'object') {
      json.customerName = o.userId.name || o.userId.fullName || '';
      json.customerEmail = o.userId.email;
      json.userId = String(o.userId._id);
    }
    return json;
  });
  return paginated(res, { data, page, limit, total });
});

// @desc  GET /api/shopping/admin/orders/:orderId — full trail
const getOrderDetail = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.orderId)) return fail(res, 400, 'Invalid order ID');
  const order = await Order.findById(req.params.orderId)
    .populate('brandId', 'name owner')
    .populate('userId', 'name fullName email phoneNumber');
  if (!order) return fail(res, 404, 'Order not found');

  const group = await OrderGroup.findById(order.orderGroup);
  const siblings = await Order.find({ orderGroup: order.orderGroup }).populate('brandId', 'name');

  const json = order.toJSON();
  json.statusHistory = order.statusHistory;
  if (order.brandId && typeof order.brandId === 'object') json.brandName = order.brandId.name;
  if (order.userId && typeof order.userId === 'object') {
    json.customerName = order.userId.name || order.userId.fullName || '';
    json.customerEmail = order.userId.email;
    json.userId = String(order.userId._id);
  }
  json.group = group ? group.toJSON() : null;
  if (json.group) {
    json.group.orders = siblings.map((s) => {
      const sj = s.toJSON();
      sj.statusHistory = s.statusHistory;
      return sj;
    });
  }
  return ok(res, json);
});

// @desc  PATCH /api/shopping/admin/orders/:orderId/status { status, reason }
// Force-transition; the mandatory reason lands in statusHistory + audit log.
const forceOrderStatus = asyncHandler(async (req, res) => {
  const { status, reason } = req.body;
  if (!status) return fail(res, 400, 'status is required');
  if (!reason) return fail(res, 400, 'A reason is mandatory for admin status changes');
  const order = await Order.findById(req.params.orderId);
  if (!order) return fail(res, 404, 'Order not found');
  const before = order.orderStatus;
  try {
    await orderService.transition(order, status, { id: req.user._id, role: 'admin' }, {
      note: `[admin] ${reason}`,
    });
  } catch (e) {
    if (e.statusCode) return fail(res, e.statusCode, e.message);
    throw e;
  }
  await audit(req.user._id, 'force_order_status', 'ShoppingOrder', order._id, {
    before: { orderStatus: before },
    after: { orderStatus: status },
    reason,
  });
  return ok(res, order);
});

// @desc  POST /api/shopping/admin/orders/:orderId/refund { reason }
const manualRefund = asyncHandler(async (req, res) => {
  if (!req.body.reason) return fail(res, 400, 'A reason is mandatory for manual refunds');
  const order = await Order.findById(req.params.orderId);
  if (!order) return fail(res, 404, 'Order not found');
  if (order.paymentStatus !== 'paid') {
    return fail(res, 400, `Only paid orders can be refunded (this one is '${order.paymentStatus}')`);
  }
  await orderService.refundToCustomer(order, `Manual refund by admin: ${req.body.reason}`);
  await orderService.reverseVendorPayout(order);
  await order.save();
  await orderService.syncGroupPaymentStatus(order.orderGroup);
  await audit(req.user._id, 'manual_refund', 'ShoppingOrder', order._id, {
    after: { paymentStatus: 'refunded', amount: order.total },
    reason: req.body.reason,
  });
  return ok(res, order);
});

/**
 * ── Platform analytics & dashboard ─────────────────────────────────
 */

// @desc  GET /api/shopping/admin/analytics?from&to
const platformAnalytics = asyncHandler(async (req, res) => {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from
    ? new Date(req.query.from)
    : new Date(to.getTime() - 30 * 86400000);
  const settings = await getShoppingSettings();
  const range = { createdAt: { $gte: from, $lte: to } };

  const orders = await Order.find(range).populate('brandId', 'name');
  const delivered = orders.filter((o) => o.orderStatus === 'delivered');
  const returns = orders.filter((o) => ['returned', 'refunded'].includes(o.orderStatus));

  const gmv = delivered.reduce((s, o) => s + o.total, 0);
  const commission = Math.round((gmv * settings.commissionPercent) / 100);

  // GMV time series by day
  const buckets = new Map();
  delivered.forEach((o) => {
    const key = o.createdAt.toISOString().slice(0, 10);
    const b = buckets.get(key) || { gmv: 0, orders: 0 };
    b.gmv += o.total;
    b.orders += 1;
    buckets.set(key, b);
  });
  const gmvSeries = [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([label, v]) => ({ label, gmv: v.gmv, orders: v.orders }));

  // Revenue by brand (top 10)
  const brandAgg = new Map();
  delivered.forEach((o) => {
    const key = String(o.brandId && o.brandId._id ? o.brandId._id : o.brandId);
    const name = o.brandId && o.brandId.name ? o.brandId.name : key;
    const row = brandAgg.get(key) || { brandId: key, brandName: name, revenue: 0, orders: 0 };
    row.revenue += o.total;
    row.orders += 1;
    brandAgg.set(key, row);
  });
  const revenueByBrand = [...brandAgg.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10);

  // Orders by status
  const ordersByStatus = {};
  orders.forEach((o) => {
    ordersByStatus[o.orderStatus] = (ordersByStatus[o.orderStatus] || 0) + 1;
  });

  // Top products platform-wide
  const productAgg = new Map();
  delivered.forEach((o) =>
    o.items.forEach((it) => {
      const key = String(it.productId);
      const row = productAgg.get(key) || {
        productId: key,
        name: it.productName,
        image: it.productImage,
        unitsSold: 0,
        revenue: 0,
      };
      row.unitsSold += it.quantity;
      row.revenue += it.totalPrice;
      productAgg.set(key, row);
    })
  );
  const topProducts = [...productAgg.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10);

  const [newCustomers, activeBrands] = await Promise.all([
    User.countDocuments({ createdAt: { $gte: from, $lte: to } }),
    Brand.countDocuments({ status: 'active', isDeleted: false }),
  ]);

  return ok(res, {
    gmv,
    gmvSeries,
    revenueByBrand,
    commission,
    ordersByStatus,
    totalOrders: orders.length,
    newCustomers,
    activeBrands,
    avgOrderValue: orders.length
      ? Math.round(orders.reduce((s, o) => s + o.total, 0) / orders.length)
      : 0,
    returnRate: orders.length ? Math.round((returns.length / orders.length) * 1000) / 10 : 0,
    topProducts,
    from,
    to,
  });
});

// @desc  GET /api/shopping/admin/dashboard — summary tiles
const adminDashboard = asyncHandler(async (req, res) => {
  const settings = await getShoppingSettings();
  const dayStart = new Date(new Date().setHours(0, 0, 0, 0));

  const [pendingBrands, ordersToday, gmvAgg, openReturns, products] = await Promise.all([
    Brand.countDocuments({ status: 'pending', isDeleted: false }),
    Order.countDocuments({ createdAt: { $gte: dayStart } }),
    Order.aggregate([
      { $match: { createdAt: { $gte: dayStart }, orderStatus: { $nin: ['cancelled'] } } },
      { $group: { _id: null, gmv: { $sum: '$total' } } },
    ]),
    ReturnRequest.countDocuments({ status: { $in: ['requested', 'approved', 'picked_up'] } }),
    Product.find({ isActive: true }).select('variants'),
  ]);

  let lowStockAlerts = 0;
  products.forEach((p) => {
    p.variants.forEach((v) => {
      if (v.stockQuantity <= settings.lowStockThreshold) lowStockAlerts += 1;
    });
  });

  return ok(res, {
    pendingBrandApprovals: pendingBrands,
    ordersToday,
    gmvToday: gmvAgg.length ? gmvAgg[0].gmv : 0,
    openReturnRequests: openReturns,
    lowStockAlerts,
  });
});

/**
 * ── Settings ───────────────────────────────────────────────────────
 */

// @desc  GET /api/shopping/admin/settings
const getSettings = asyncHandler(async (req, res) => ok(res, await getShoppingSettings()));

// @desc  PATCH /api/shopping/admin/settings
const patchSettings = asyncHandler(async (req, res) => {
  const before = await getShoppingSettings();
  const after = await updateShoppingSettings(req.body, req.user._id);
  await audit(req.user._id, 'update_settings', 'ShoppingSettings', null, { before, after });
  return ok(res, after);
});

module.exports = {
  listAllOrders,
  getOrderDetail,
  forceOrderStatus,
  manualRefund,
  platformAnalytics,
  adminDashboard,
  getSettings,
  patchSettings,
};
