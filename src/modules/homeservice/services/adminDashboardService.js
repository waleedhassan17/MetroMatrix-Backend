const Booking = require('../models/Booking');
const Dispute = require('../models/Dispute');
const PayoutRequest = require('../models/PayoutRequest');
const Provider = require('../../../models/Provider');
const { todayWindow } = require('../../../utils/time');
const { stateFilter } = require('../../../services/admin/providerStatus');

/**
 * Home-services headline figures — used by GET /api/admin/homeservice/dashboard
 * and composed into GET /api/admin/overview.
 *
 * "Today" is the Asia/Karachi day (it used to be the server's, i.e. UTC, so
 * the day flipped at 5 am Pakistan time). GMV counts what a booking actually
 * bills — same order as money.js billOf(): the provider's requested amount,
 * else the final price, else the estimate.
 */
const BILL = {
  $let: {
    vars: {
      r: { $ifNull: ['$payment.requestedAmount', 0] },
      f: { $ifNull: ['$pricing.finalPrice', 0] },
      e: { $ifNull: ['$pricing.estimatedPrice', 0] },
    },
    in: { $cond: [{ $gt: ['$$r', 0] }, '$$r', { $cond: [{ $gt: ['$$f', 0] }, '$$f', '$$e'] }] },
  },
};

async function homeserviceDashboard(now = new Date()) {
  const today = todayWindow(now);
  const [pendingProviders, bookingsToday, gmvAgg, openDisputes, pendingPayouts, onlineProviders] = await Promise.all([
    Provider.countDocuments({ providerType: 'home_service', ...stateFilter('pending') }),
    Booking.countDocuments({ createdAt: { $gte: today.from, $lt: today.to } }),
    Booking.aggregate([
      { $match: { 'payment.status': 'paid', 'payment.paidAt': { $gte: today.from, $lt: today.to } } },
      { $group: { _id: null, gmv: { $sum: BILL } } },
    ]),
    Dispute.countDocuments({ status: { $in: ['open', 'investigating'] } }),
    PayoutRequest.countDocuments({ status: 'pending' }),
    Provider.countDocuments({ providerType: 'home_service', isOnline: true, ...stateFilter('approved') }),
  ]);
  return {
    pendingProviderApprovals: pendingProviders,
    bookingsToday,
    gmvToday: gmvAgg[0]?.gmv || 0,
    openDisputes,
    pendingPayouts,
    activeProvidersOnline: onlineProviders,
  };
}

module.exports = { homeserviceDashboard };
