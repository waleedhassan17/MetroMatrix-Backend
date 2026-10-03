const Brand = require('../models/Brand');
const Order = require('../models/Order');
const ReturnRequest = require('../models/ReturnRequest');
const Product = require('../models/Product');
const { getShoppingSettings } = require('./settingsService');
const { todayWindow } = require('../../../utils/time');

/**
 * Shopping headline figures — used by GET /api/shopping/admin/dashboard and
 * composed into GET /api/admin/overview.
 *
 * Low stock is counted in the database ($unwind + $match) instead of loading
 * every active product's variants into memory. Same rule as the inventory
 * screens: running out (1..threshold), not already out. "Today" is the
 * Asia/Karachi day.
 */
const OPEN_RETURN_STATUSES = ['requested', 'approved', 'picked_up'];

async function shoppingDashboard(now = new Date()) {
  const settings = await getShoppingSettings();
  const today = todayWindow(now);
  const [pendingBrands, ordersToday, gmvAgg, openReturns, lowStockAgg] = await Promise.all([
    Brand.countDocuments({ status: 'pending', isDeleted: false }),
    Order.countDocuments({ createdAt: { $gte: today.from, $lt: today.to } }),
    Order.aggregate([
      { $match: { createdAt: { $gte: today.from, $lt: today.to }, orderStatus: { $nin: ['cancelled'] } } },
      { $group: { _id: null, gmv: { $sum: '$total' } } },
    ]),
    ReturnRequest.countDocuments({ status: { $in: OPEN_RETURN_STATUSES } }),
    Product.aggregate([
      { $match: { isActive: true } },
      { $unwind: '$variants' },
      { $match: { 'variants.stockQuantity': { $gt: 0, $lte: settings.lowStockThreshold } } },
      { $count: 'n' },
    ]),
  ]);
  return {
    pendingBrandApprovals: pendingBrands,
    ordersToday,
    gmvToday: gmvAgg[0]?.gmv || 0,
    openReturnRequests: openReturns,
    lowStockAlerts: lowStockAgg[0]?.n || 0,
  };
}

module.exports = { shoppingDashboard, OPEN_RETURN_STATUSES };
