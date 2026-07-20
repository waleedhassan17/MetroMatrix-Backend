const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const PayoutRequest = require('../models/PayoutRequest');
const WalletService = require('../../../services/walletService');
const WalletTransaction = require('../../../models/WalletTransaction');
const { getHomeserviceSettings } = require('../services/settingsService');
const { pendingCommission } = require('../services/paymentService');
const { STATUS } = require('../services/statusMap');

const ok = (res, data, message) => res.json({ success: true, data, message });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * GET /api/provider/earnings?period=daily|weekly|monthly|all (also accepts the
 * frontend's week|month|year) → EarningsData. Aggregation pipelines, not
 * in-memory loops.
 */
const getEarnings = asyncHandler(async (req, res) => {
  const providerId = new mongoose.Types.ObjectId(String(req.user._id));
  const settings = await getHomeserviceSettings();
  const commissionFactor = 1 - settings.commissionPercent / 100;

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const paidMatch = {
    provider: providerId,
    status: STATUS.COMPLETED,
    'payment.status': 'paid',
  };

  const grossExpr = { $ifNull: ['$pricing.finalPrice', '$pricing.estimatedPrice'] };

  const [totals, monthly, perJob] = await Promise.all([
    Booking.aggregate([
      { $match: paidMatch },
      {
        $group: {
          _id: null,
          gross: { $sum: grossExpr },
          jobs: { $sum: 1 },
          grossThisMonth: {
            $sum: {
              $cond: [{ $gte: ['$payment.paidAt', startOfMonth] }, grossExpr, 0],
            },
          },
        },
      },
    ]),
    Booking.aggregate([
      { $match: { ...paidMatch, 'payment.paidAt': { $gte: sixMonthsAgo } } },
      {
        $group: {
          _id: { y: { $year: '$payment.paidAt' }, m: { $month: '$payment.paidAt' } },
          amount: { $sum: grossExpr },
          jobs: { $sum: 1 },
        },
      },
      { $sort: { '_id.y': 1, '_id.m': 1 } },
    ]),
    Booking.aggregate([
      { $match: paidMatch },
      { $sort: { 'payment.paidAt': -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: 'users',
          localField: 'customer',
          foreignField: '_id',
          as: 'customerDoc',
        },
      },
      {
        $project: {
          amount: grossExpr,
          paidAt: '$payment.paidAt',
          service: { $ifNull: ['$serviceSubCategory', '$serviceCategory'] },
          customerName: { $arrayElemAt: ['$customerDoc.fullName', 0] },
        },
      },
    ]),
  ]);

  const t = totals[0] || { gross: 0, jobs: 0, grossThisMonth: 0 };
  const net = (v) => Math.round(v * commissionFactor);

  const [payouts, pendingPayoutAgg, wallet, pendingComm] = await Promise.all([
    PayoutRequest.find({ provider: providerId }).sort({ createdAt: -1 }).limit(5),
    PayoutRequest.aggregate([
      { $match: { provider: providerId, status: 'pending' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    WalletService.getOrCreateWallet(providerId, 'Provider'),
    pendingCommission(providerId),
  ]);
  const pendingPayouts = (pendingPayoutAgg[0] && pendingPayoutAgg[0].total) || 0;

  // Month-over-month growth from the two most recent monthly buckets
  let monthlyGrowth = 0;
  if (monthly.length >= 2) {
    const last = monthly[monthly.length - 1].amount;
    const prev = monthly[monthly.length - 2].amount;
    if (prev > 0) monthlyGrowth = Math.round(((last - prev) / prev) * 100);
  }

  const recentPayments = [
    ...perJob.map((j) => ({
      id: String(j._id),
      type: 'earning',
      amount: net(j.amount),
      date: j.paidAt ? j.paidAt.toISOString().slice(0, 10) : '',
      status: 'completed',
      description: `${j.service} - ${j.customerName || 'Customer'}`,
    })),
    ...payouts.map((p) => ({
      id: String(p._id),
      type: 'payout',
      amount: p.amount,
      date: p.createdAt.toISOString().slice(0, 10),
      status: p.status === 'approved' ? 'completed' : p.status === 'rejected' ? 'failed' : 'pending',
      description: `Payout (${p.method})`,
    })),
  ].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 10);

  const completed = await Booking.countDocuments({
    provider: providerId,
    status: STATUS.COMPLETED,
  });
  const decided = await Booking.countDocuments({
    provider: providerId,
    status: { $in: [STATUS.COMPLETED, STATUS.CANCELLED, STATUS.REJECTED] },
  });

  ok(res, {
    stats: {
      totalEarnings: net(t.gross),
      thisMonthEarnings: net(t.grossThisMonth),
      pendingPayouts,
      completedJobsCount: t.jobs,
      monthlyGrowth,
    },
    monthlyData: monthly.map((m) => ({
      month: MONTHS[m._id.m - 1],
      amount: net(m.amount),
      jobs: m.jobs,
    })),
    recentPayments,
    performance: {
      avgRating: req.user.ratings ? req.user.ratings.average || 0 : 0,
      onTimeRate: decided ? Math.round((completed / decided) * 100) : 100,
      statusTier: completed >= 100 ? 'Gold' : completed >= 25 ? 'Silver' : 'Bronze',
      repeatCustomerRate: 0,
    },
    availableBalance: Math.max(0, wallet.balance - pendingComm),
    commissionPercent: settings.commissionPercent,
  }, 'Earnings data fetched');
});

/**
 * POST /api/provider/earnings/payout (also /api/provider/payout-request)
 * — { amount, method, accountDetails? }. Rejected when the amount exceeds the
 * available balance (wallet minus unsettled cash commissions minus payouts
 * already pending).
 */
const requestPayout = asyncHandler(async (req, res) => {
  const { amount, method, accountDetails } = req.body;
  const amountN = Number(amount);
  if (!amountN || amountN <= 0) {
    res.status(400);
    throw new Error('A positive payout amount is required');
  }
  const settings = await getHomeserviceSettings();
  if (amountN < settings.minPayoutAmount) {
    res.status(400);
    throw new Error(`Minimum payout amount is Rs. ${settings.minPayoutAmount}`);
  }

  const wallet = await WalletService.getOrCreateWallet(req.user._id, 'Provider');
  const [pendingComm, pendingPayoutAgg] = await Promise.all([
    pendingCommission(req.user._id),
    PayoutRequest.aggregate([
      {
        $match: {
          provider: new mongoose.Types.ObjectId(String(req.user._id)),
          status: 'pending',
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);
  const alreadyRequested = (pendingPayoutAgg[0] && pendingPayoutAgg[0].total) || 0;
  const available = wallet.balance - pendingComm - alreadyRequested;

  if (amountN > available) {
    res.status(400);
    throw new Error(
      `Payout exceeds available balance (Rs. ${Math.max(0, available).toLocaleString('en-PK')})`
    );
  }

  const payout = await PayoutRequest.create({
    provider: req.user._id,
    amount: amountN,
    method: method || 'bank',
    accountDetails: accountDetails || {},
  });

  ok(res, { payoutId: String(payout._id), status: 'processing' }, 'Payout requested');
});

module.exports = { getEarnings, requestPayout };
