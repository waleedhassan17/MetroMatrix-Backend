const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const PayoutRequest = require('../models/PayoutRequest');
const WalletService = require('../../../services/walletService');
const WalletTransaction = require('../../../models/WalletTransaction');
const { getHomeserviceSettings } = require('../services/settingsService');
const { pendingCommission } = require('../services/paymentService');
const { STATUS } = require('../services/statusMap');
const { outcomeStats, onTimeRate, repeatCustomerRate } = require('../services/providerStats');
const {
  DAY_MS,
  pktDateString,
  pktDayBounds,
  pktMonthStart,
  pktYearStart,
} = require('../services/time');

const ok = (res, data, message) => res.json({ success: true, data, message });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TZ = 'Asia/Karachi';

/**
 * The period the provider picked. Accepts the app's W/M/Y chips, the
 * network layer's week/month/year and the older daily/weekly/monthly words.
 */
function normalizePeriod(raw) {
  const p = String(raw || '').toLowerCase();
  if (['w', 'week', 'weekly'].includes(p)) return 'week';
  if (['y', 'year', 'yearly'].includes(p)) return 'year';
  if (p === 'all') return 'all';
  return 'month';
}

/**
 * GET /api/provider/earnings?period=week|month|year|all → EarningsData.
 *
 * `period` used to be documented here and ignored, so the Earnings tab's
 * period chips changed nothing. It now picks the headline figure
 * (`periodEarnings`) and the chart (`series`): the last 7 days by day, or the
 * last 6 / 12 months by month. Every calendar boundary is Pakistan time.
 * All figures are what the provider keeps: paid jobs, net of commission.
 */
const getEarnings = asyncHandler(async (req, res) => {
  const providerId = new mongoose.Types.ObjectId(String(req.user._id));
  const settings = await getHomeserviceSettings();
  const commissionFactor = 1 - settings.commissionPercent / 100;
  const period = normalizePeriod(req.query.period);

  const now = new Date();
  const startOfMonth = pktMonthStart(now);
  const seriesMonths = period === 'year' ? 12 : 6;
  const seriesStart =
    period === 'week'
      ? pktDayBounds(new Date(now.getTime() - 6 * DAY_MS)).start
      : pktMonthStart(now, -(seriesMonths - 1));
  const periodStart =
    period === 'week'
      ? seriesStart
      : period === 'year'
      ? pktYearStart(now)
      : period === 'all'
      ? new Date(0)
      : startOfMonth;

  const paidMatch = {
    provider: providerId,
    status: STATUS.COMPLETED,
    'payment.status': 'paid',
  };

  // The bill: requested amount, else final price, else estimate — the same
  // order services/money.js billOf() uses everywhere else.
  const grossExpr = {
    $ifNull: ['$payment.requestedAmount', { $ifNull: ['$pricing.finalPrice', '$pricing.estimatedPrice'] }],
  };
  const bucketFormat = period === 'week' ? '%Y-%m-%d' : '%Y-%m';

  const [totals, buckets, sixMonthBuckets, perJob] = await Promise.all([
    Booking.aggregate([
      { $match: paidMatch },
      {
        $group: {
          _id: null,
          gross: { $sum: grossExpr },
          jobs: { $sum: 1 },
          grossThisMonth: {
            $sum: { $cond: [{ $gte: ['$payment.paidAt', startOfMonth] }, grossExpr, 0] },
          },
          grossPeriod: {
            $sum: { $cond: [{ $gte: ['$payment.paidAt', periodStart] }, grossExpr, 0] },
          },
          jobsPeriod: {
            $sum: { $cond: [{ $gte: ['$payment.paidAt', periodStart] }, 1, 0] },
          },
        },
      },
    ]),
    Booking.aggregate([
      { $match: { ...paidMatch, 'payment.paidAt': { $gte: seriesStart } } },
      {
        $group: {
          _id: { $dateToString: { format: bucketFormat, date: '$payment.paidAt', timezone: TZ } },
          amount: { $sum: grossExpr },
          jobs: { $sum: 1 },
        },
      },
    ]),
    // The legacy six-month series, still sent as `monthlyData` for app builds
    // that predate `series`.
    Booking.aggregate([
      { $match: { ...paidMatch, 'payment.paidAt': { $gte: pktMonthStart(now, -5) } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$payment.paidAt', timezone: TZ } },
          amount: { $sum: grossExpr },
          jobs: { $sum: 1 },
        },
      },
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
          method: '$payment.method',
          service: { $ifNull: ['$serviceSubCategory', '$serviceCategory'] },
          customerName: { $arrayElemAt: ['$customerDoc.fullName', 0] },
        },
      },
    ]),
  ]);

  const t = totals[0] || { gross: 0, jobs: 0, grossThisMonth: 0, grossPeriod: 0, jobsPeriod: 0 };
  const net = (v) => Math.round(v * commissionFactor);

  const [payouts, pendingPayoutAgg, wallet, pendingComm, outcomes, onTime, repeat] = await Promise.all([
    PayoutRequest.find({ provider: providerId }).sort({ createdAt: -1 }).limit(5),
    PayoutRequest.aggregate([
      { $match: { provider: providerId, status: 'pending' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    WalletService.getOrCreateWallet(providerId, 'Provider'),
    pendingCommission(providerId),
    outcomeStats(providerId),
    onTimeRate(providerId),
    repeatCustomerRate(providerId),
  ]);
  const pendingPayouts = (pendingPayoutAgg[0] && pendingPayoutAgg[0].total) || 0;

  // Every bucket in the window, zero-filled, so the chart's axis is complete
  // instead of skipping the weeks with no work.
  const byKey = new Map(buckets.map((b) => [b._id, b]));
  const series = [];
  if (period === 'week') {
    for (let i = 6; i >= 0; i -= 1) {
      const day = new Date(now.getTime() - i * DAY_MS);
      const key = pktDateString(day);
      const hit = byKey.get(key);
      const weekday = new Date(`${key}T12:00:00.000Z`).getUTCDay();
      series.push({ key, label: WEEKDAY_SHORT[weekday], amount: net(hit ? hit.amount : 0), jobs: hit ? hit.jobs : 0 });
    }
  } else {
    for (let i = seriesMonths - 1; i >= 0; i -= 1) {
      const key = pktDateString(pktMonthStart(now, -i)).slice(0, 7);
      const hit = byKey.get(key);
      series.push({ key, label: MONTHS[Number(key.slice(5, 7)) - 1], amount: net(hit ? hit.amount : 0), jobs: hit ? hit.jobs : 0 });
    }
  }
  const sixByKey = new Map(sixMonthBuckets.map((b) => [b._id, b]));
  const monthlyData = [];
  for (let i = 5; i >= 0; i -= 1) {
    const key = pktDateString(pktMonthStart(now, -i)).slice(0, 7);
    const hit = sixByKey.get(key);
    monthlyData.push({ month: MONTHS[Number(key.slice(5, 7)) - 1], amount: net(hit ? hit.amount : 0), jobs: hit ? hit.jobs : 0 });
  }

  // Month-over-month growth from the two most recent months.
  let monthlyGrowth = 0;
  const last = monthlyData[monthlyData.length - 1].amount;
  const prev = monthlyData[monthlyData.length - 2].amount;
  if (prev > 0) monthlyGrowth = Math.round(((last - prev) / prev) * 100);

  const recentPayments = [
    ...perJob.map((j) => ({
      id: String(j._id),
      bookingId: String(j._id),
      type: 'earning',
      amount: net(j.amount),
      grossAmount: Math.round(j.amount),
      method: j.method || null,
      date: j.paidAt ? j.paidAt.toISOString() : '',
      status: 'completed',
      description: `${j.service} - ${j.customerName || 'Customer'}`,
    })),
    ...payouts.map((p) => ({
      id: String(p._id),
      type: 'payout',
      amount: p.amount,
      date: p.createdAt.toISOString(),
      status: p.status === 'approved' ? 'completed' : p.status === 'rejected' ? 'failed' : 'pending',
      description: `Payout (${p.method})`,
    })),
  ].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 10);

  const completed = outcomes.completed;
  const rating = req.user.ratings ? Math.round((req.user.ratings.average || 0) * 10) / 10 : 0;

  ok(res, {
    period,
    periodEarnings: net(t.grossPeriod),
    periodJobs: t.jobsPeriod,
    series,
    seriesTitle: period === 'week' ? 'Last 7 days' : period === 'year' ? 'Last 12 months' : 'Last 6 months',
    stats: {
      totalEarnings: net(t.gross),
      thisMonthEarnings: net(t.grossThisMonth),
      pendingPayouts,
      completedJobsCount: t.jobs,
      monthlyGrowth,
    },
    monthlyData,
    recentPayments,
    performance: {
      avgRating: rating,
      // null means "no track record yet" — the app shows a dash, not a number
      // nobody earned.
      onTimeRate: onTime,
      completionRate: outcomes.completionRate,
      statusTier: completed >= 100 ? 'Gold' : completed >= 25 ? 'Silver' : 'Bronze',
      repeatCustomerRate: repeat,
    },
    // Same formula requestPayout() enforces — a provider must never see an
    // "available" figure here that a payout request would then reject.
    availableBalance: Math.max(0, wallet.balance - pendingComm - pendingPayouts),
    walletBalance: wallet.balance,
    pendingCommission: pendingComm,
    minPayoutAmount: settings.minPayoutAmount,
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
