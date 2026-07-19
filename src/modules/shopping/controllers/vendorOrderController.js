const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const ReturnRequest = require('../models/ReturnRequest');
const ProductReview = require('../models/ProductReview');
const orderService = require('../services/orderService');
const { getShoppingSettings } = require('../services/settingsService');
const { ok, paginated, fail, parsePagination } = require('../utils/respond');

// @desc  GET /api/shopping/vendor/orders?status&page&limit
const getBrandOrders = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = { brandId: req.brand._id };
  if (req.query.status) filter.orderStatus = req.query.status;
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .populate('userId', 'name fullName email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Order.countDocuments(filter),
  ]);
  const data = orders.map((o) => {
    const json = o.toJSON();
    if (o.userId && typeof o.userId === 'object') {
      json.customerName = o.userId.name || o.userId.fullName || '';
      json.userId = String(o.userId._id);
    }
    return json;
  });
  return paginated(res, { data, page, limit, total });
});

// @desc  GET /api/shopping/vendor/orders/:orderId
const getBrandOrder = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.orderId)) return fail(res, 400, 'Invalid order ID');
  const order = await Order.findOne({ _id: req.params.orderId, brandId: req.brand._id }).populate(
    'userId',
    'name fullName email phoneNumber'
  );
  if (!order) return fail(res, 404, 'Order not found');
  const json = order.toJSON();
  if (order.userId && typeof order.userId === 'object') {
    json.customerName = order.userId.name || order.userId.fullName || '';
    json.customerEmail = order.userId.email;
    json.userId = String(order.userId._id);
  }
  json.statusHistory = order.statusHistory;
  return ok(res, json);
});

// @desc  PATCH /api/shopping/vendor/orders/:orderId/status { status, note, trackingNumber }
const updateOrderStatus = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.orderId)) return fail(res, 400, 'Invalid order ID');
  const order = await Order.findOne({ _id: req.params.orderId, brandId: req.brand._id });
  if (!order) return fail(res, 404, 'Order not found');
  if (!req.body.status) return fail(res, 400, 'status is required');
  try {
    await orderService.transition(order, req.body.status, { id: req.user._id, role: 'vendor' }, {
      note: req.body.note,
      trackingNumber: req.body.trackingNumber,
    });
  } catch (e) {
    if (e.statusCode) return fail(res, e.statusCode, e.message);
    throw e;
  }
  return ok(res, order);
});

// @desc  GET /api/shopping/vendor/returns
const getBrandReturns = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = { brandId: req.brand._id };
  if (req.query.status) filter.status = req.query.status;
  const [rows, total] = await Promise.all([
    ReturnRequest.find(filter)
      .populate('userId', 'name fullName')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    ReturnRequest.countDocuments(filter),
  ]);
  return paginated(res, { data: rows, page, limit, total });
});

const RETURN_FLOW = {
  requested: ['approved', 'rejected'],
  approved: ['picked_up'],
  picked_up: ['refunded'],
  rejected: [],
  refunded: [],
};

// @desc  PATCH /api/shopping/vendor/returns/:returnId { status, vendorNote }
// Moving to 'refunded' restores stock and triggers the wallet refund via
// the order state machine (returned → refunded).
const updateReturnRequest = asyncHandler(async (req, res) => {
  const request = await ReturnRequest.findOne({
    _id: req.params.returnId,
    brandId: req.brand._id,
  });
  if (!request) return fail(res, 404, 'Return request not found');
  const nextStatus = req.body.status;
  if (!nextStatus || !(RETURN_FLOW[request.status] || []).includes(nextStatus)) {
    return fail(res, 400, `Cannot move a return from '${request.status}' to '${nextStatus}'`);
  }
  if (req.body.vendorNote !== undefined) request.vendorNote = req.body.vendorNote;
  request.status = nextStatus;

  const order = await Order.findById(request.order);
  const actor = { id: req.user._id, role: 'vendor' };

  if (nextStatus === 'approved' && order && order.orderStatus === 'delivered') {
    await orderService.transition(order, 'returned', actor, { note: 'Return approved by vendor' });
  }

  if (nextStatus === 'refunded') {
    // Restore stock for the returned items
    for (const item of request.items) {
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
    if (order && order.orderStatus === 'returned') {
      await orderService.transition(order, 'refunded', actor, { note: 'Refund issued for return' });
    }
  }

  await request.save();
  return ok(res, request);
});

/**
 * ── Analytics & dashboard (shapes match BrandAnalytics/BrandHome screens) ──
 */

const PERIOD_DAYS = { '7d': 7, '30d': 30, '90d': 90 };

const rangeFor = (req) => {
  if (req.query.from || req.query.to) {
    const from = req.query.from ? new Date(req.query.from) : new Date(0);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    return { from, to };
  }
  const days = PERIOD_DAYS[req.query.period] || 30;
  const to = new Date();
  const from = req.query.period === 'all' ? new Date(0) : new Date(to.getTime() - days * 86400000);
  return { from, to };
};

const REVENUE_STATUSES = ['delivered'];
const SOLD_STATUSES = ['confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered'];

// @desc  GET /api/shopping/vendor/analytics?period=7d|30d|90d|all (or from&to)
const getBrandAnalytics = asyncHandler(async (req, res) => {
  const { from, to } = rangeFor(req);
  const settings = await getShoppingSettings();
  const brandId = req.brand._id;
  const match = { brandId, createdAt: { $gte: from, $lte: to } };

  const orders = await Order.find(match);
  const delivered = orders.filter((o) => REVENUE_STATUSES.includes(o.orderStatus));
  const active = orders.filter((o) => SOLD_STATUSES.includes(o.orderStatus));
  const returns = orders.filter((o) => ['returned', 'refunded'].includes(o.orderStatus));

  const totalRevenue = delivered.reduce((s, o) => s + o.total, 0);
  const commission = Math.round((totalRevenue * settings.commissionPercent) / 100);
  const shippingCollected = delivered.reduce((s, o) => s + o.shippingFee, 0);
  const refundsAmount = returns.reduce((s, o) => s + o.total, 0);

  // Revenue time series bucketed by day
  const buckets = new Map();
  delivered.forEach((o) => {
    const key = o.createdAt.toISOString().slice(0, 10);
    const bucket = buckets.get(key) || { revenue: 0, orders: 0 };
    bucket.revenue += o.total;
    bucket.orders += 1;
    buckets.set(key, bucket);
  });
  const revenueChart = [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([label, v]) => ({ label, revenue: v.revenue, orders: v.orders }));

  // Top products by units and revenue
  const productAgg = new Map();
  active.forEach((o) =>
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

  // Category breakdown via product → category lookup
  const productIds = [...productAgg.keys()];
  const products = await Product.find({ _id: { $in: productIds } }).populate('categoryId', 'name');
  const catNames = new Map(products.map((p) => [String(p._id), p.categoryId ? p.categoryId.name : 'Uncategorised']));
  const catAgg = new Map();
  productAgg.forEach((row, pid) => {
    const cat = catNames.get(pid) || 'Uncategorised';
    catAgg.set(cat, (catAgg.get(cat) || 0) + row.revenue);
  });
  const catTotal = [...catAgg.values()].reduce((s, v) => s + v, 0) || 1;
  const palette = ['#E67E22', '#3498DB', '#2ECC71', '#9B59B6', '#F1C40F', '#E74C3C', '#1ABC9C'];
  const categoryBreakdown = [...catAgg.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([category, revenue], i) => ({
      category,
      revenue,
      percentage: Math.round((revenue / catTotal) * 100),
      color: palette[i % palette.length],
    }));

  // Previous period for trend
  const spanMs = to.getTime() - from.getTime();
  const prevOrders = await Order.find({
    brandId,
    orderStatus: { $in: REVENUE_STATUSES },
    createdAt: { $gte: new Date(from.getTime() - spanMs), $lt: from },
  });
  const previousPeriodRevenue = prevOrders.reduce((s, o) => s + o.total, 0);

  const summary = {
    totalRevenue,
    totalIncome: totalRevenue - commission,
    totalExpenses: shippingCollected + refundsAmount,
    netProfit: totalRevenue - commission - refundsAmount,
    totalOrders: orders.length,
    avgOrderValue: orders.length ? Math.round(orders.reduce((s, o) => s + o.total, 0) / orders.length) : 0,
    conversionRate: 0, // needs traffic data — not tracked at FYP scope
    returnsCount: returns.length,
    refundsAmount,
  };

  return ok(res, { summary, revenueChart, topProducts, categoryBreakdown, previousPeriodRevenue });
});

// @desc  GET /api/shopping/vendor/dashboard — BrandHome tiles
const getBrandDashboard = asyncHandler(async (req, res) => {
  const settings = await getShoppingSettings();
  const brandId = req.brand._id;
  const weekAgo = new Date(Date.now() - 7 * 86400000);

  const [orders, products, recentOrdersDocs] = await Promise.all([
    Order.find({ brandId }),
    Product.find({ brandId, isActive: true }),
    Order.find({ brandId })
      .populate('userId', 'name fullName')
      .sort({ createdAt: -1 })
      .limit(5),
  ]);

  const delivered = orders.filter((o) => o.orderStatus === 'delivered');
  const revenue = delivered.reduce((s, o) => s + o.total, 0);
  const commission = Math.round((revenue * settings.commissionPercent) / 100);
  const shipped = orders.filter((o) => ['shipped', 'out_for_delivery'].includes(o.orderStatus));
  const closed = orders.filter((o) => ['delivered', 'cancelled', 'returned', 'refunded'].includes(o.orderStatus));

  const lowStockAlerts = [];
  products.forEach((p) => {
    p.variants.forEach((v) => {
      if (v.stockQuantity <= settings.lowStockThreshold) {
        lowStockAlerts.push({ productId: String(p._id), name: p.name, stock: v.stockQuantity });
      }
    });
  });

  // Orders per day for the last 7 days
  const weeklySales = Array.from({ length: 7 }, (_, i) => {
    const dayStart = new Date(new Date().setHours(0, 0, 0, 0) - (6 - i) * 86400000);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    return orders.filter((o) => o.createdAt >= dayStart && o.createdAt < dayEnd).length;
  });

  return ok(res, {
    kpis: {
      revenue,
      income: revenue - commission,
      orders: orders.length,
      products: products.length,
      lowStock: lowStockAlerts.length,
      activeShipments: shipped.length,
      deliveryRate: closed.length
        ? Math.round((delivered.length / closed.length) * 1000) / 10
        : 0,
    },
    weeklySales,
    recentOrders: recentOrdersDocs.map((o) => ({
      orderId: String(o._id),
      odexId: o.odexId,
      customerName:
        o.userId && typeof o.userId === 'object' ? o.userId.name || o.userId.fullName || '' : '',
      orderStatus: o.orderStatus,
      total: o.total,
      createdAt: o.createdAt,
    })),
    lowStockAlerts: lowStockAlerts.slice(0, 10),
  });
});

module.exports = {
  getBrandOrders,
  getBrandOrder,
  updateOrderStatus,
  getBrandReturns,
  updateReturnRequest,
  getBrandAnalytics,
  getBrandDashboard,
};
