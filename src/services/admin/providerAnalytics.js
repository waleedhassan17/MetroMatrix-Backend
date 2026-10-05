/**
 * One provider's analytics for the admin console — GET
 * /api/admin/providers/:providerId/analytics?range=30d|90d|12m.
 *
 * The same shape for every kind of provider, so the app draws one screen:
 *
 *   summary     Metric[] (the shape the overview uses). Figures for the range
 *               carry period 'range' and, where a previous range of the same
 *               length exists to compare with, a delta in percent.
 *   series      one bucket per Pakistan day (30d, 90d) or month (12m), gaps
 *               filled with zeros: count = jobs / appointments / orders made,
 *               amount = money paid for completed work.
 *   breakdowns  labelled rows (by status, category, type, product ...).
 *   recent      the latest bookings / appointments / orders, newest first.
 *   wallet      balance, money earned through the wallet, pending payouts.
 *   links       the doctor or brand records behind the provider.
 *
 * Money is what the provider was paid: there is no platform commission.
 * Anything that cannot be measured (no finished work yet) is null, never 0.
 */
const mongoose = require('mongoose');
const Booking = require('../../modules/homeservice/models/Booking');
const PayoutRequest = require('../../modules/homeservice/models/PayoutRequest');
const ProviderReview = require('../../modules/homeservice/models/ProviderReview');
const { STATUS } = require('../../modules/homeservice/services/statusMap');
const { outcomeStats, onTimeRate, repeatCustomerRate } = require('../../modules/homeservice/services/providerStats');
const { DAY_MS, pktDateString, pktDayBounds, pktMonthStart } = require('../../modules/homeservice/services/time');
const Doctor = require('../../modules/healthcare/models/Doctor');
const Appointment = require('../../modules/healthcare/models/Appointment');
const Clinic = require('../../modules/healthcare/models/Clinic');
const Brand = require('../../modules/shopping/models/Brand');
const Order = require('../../modules/shopping/models/Order');
const Product = require('../../modules/shopping/models/Product');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const { growthPct } = require('../../utils/time');
const { WALLET_CURRENCY } = require('../../config/currency');

const TZ = 'Asia/Karachi';
const RECENT = 8;

const RANGES = {
  '30d': { label: 'Last 30 days', days: 30, bucket: 'day' },
  '90d': { label: 'Last 90 days', days: 90, bucket: 'day' },
  '12m': { label: 'Last 12 months', months: 12, bucket: 'month' },
};
const DEFAULT_RANGE = '30d';

const metric = (key, label, value, unit, period, extra = {}) => ({ key, label, value, unit, period, ...extra });
const ranged = (key, label, value, previous, unit) =>
  metric(key, label, value, unit, 'range', { delta: growthPct(value, previous), comparedTo: 'previous_range' });
const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : null);

/** [from, to) of the range ending now, the range before it, and its bucket keys. */
function windowOf(range, now = new Date()) {
  const r = RANGES[range];
  const to = now;
  let from;
  let prevFrom;
  if (r.bucket === 'month') {
    from = pktMonthStart(now, -(r.months - 1));
    prevFrom = pktMonthStart(now, -(2 * r.months - 1));
  } else {
    from = pktDayBounds(new Date(now.getTime() - (r.days - 1) * DAY_MS)).start;
    prevFrom = new Date(from.getTime() - r.days * DAY_MS);
  }
  const keys = [];
  if (r.bucket === 'month') {
    for (let i = r.months - 1; i >= 0; i -= 1) keys.push(pktDateString(pktMonthStart(now, -i)).slice(0, 7));
  } else {
    for (let i = r.days - 1; i >= 0; i -= 1) keys.push(pktDateString(new Date(now.getTime() - i * DAY_MS)));
  }
  return { range, label: r.label, bucket: r.bucket, from, to, prevFrom, keys, format: r.bucket === 'month' ? '%Y-%m' : '%Y-%m-%d' };
}

const bucketOf = (win, field) => ({ $dateToString: { format: win.format, date: field, timezone: TZ } });

/** Merge count rows and amount rows into one zero-filled series. */
function fillSeries(win, countRows, amountRows) {
  const counts = new Map(countRows.map((r) => [r._id, r.n]));
  const amounts = new Map(amountRows.map((r) => [r._id, r.amount]));
  return win.keys.map((date) => ({ date, count: counts.get(date) || 0, amount: Math.round(amounts.get(date) || 0) }));
}

const rowsOf = (entries, labels = {}) =>
  entries
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([key, value]) => ({ key, label: labels[key] || humanise(key), value }));

const humanise = (s) => {
  const t = String(s || 'Unknown').replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

// ── Wallet (every provider type) ──────────────────────────────────────────

const EARNING_SOURCES = ['service_payment', 'homeservice_payment', 'homeservice_earning', 'healthcare_earning', 'shopping_earning'];

async function walletOf(providerId) {
  const wallet = await Wallet.findOne({ owner: providerId, ownerType: 'Provider' }).select('balance').lean();
  const [earned, pending] = await Promise.all([
    wallet
      ? WalletTransaction.aggregate([
          { $match: { wallet: wallet._id, type: 'credit', status: 'completed', source: { $in: EARNING_SOURCES } } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ])
      : [],
    PayoutRequest.aggregate([
      { $match: { provider: providerId, status: 'pending' } },
      { $group: { _id: null, total: { $sum: '$amount' }, n: { $sum: 1 } } },
    ]),
  ]);
  return {
    balance: wallet ? wallet.balance : 0,
    lifetimeEarnings: Math.round(earned[0]?.total || 0),
    pendingPayouts: { count: pending[0]?.n || 0, amount: Math.round(pending[0]?.total || 0) },
  };
}

// ── Home services ─────────────────────────────────────────────────────────

const billExpr = {
  $ifNull: ['$payment.requestedAmount', { $ifNull: ['$pricing.finalPrice', '$pricing.estimatedPrice'] }],
};

async function homeService(provider, win) {
  const id = provider._id;
  const paid = { provider: id, status: STATUS.COMPLETED, 'payment.status': 'paid' };
  const made = (from, to) => ({ provider: id, createdAt: { $gte: from, $lt: to } });
  const paidIn = (from, to) => ({ ...paid, 'payment.paidAt': { $gte: from, $lt: to } });
  const sum = (match) =>
    Booking.aggregate([{ $match: match }, { $group: { _id: null, amount: { $sum: billExpr }, n: { $sum: 1 } } }]);

  const [countRows, amountRows, prevJobs, cur, prev, byStatus, byCategory, ratingRows, outcomes, onTime, repeat, lengthRows, recent] =
    await Promise.all([
      Booking.aggregate([{ $match: made(win.from, win.to) }, { $group: { _id: bucketOf(win, '$createdAt'), n: { $sum: 1 } } }]),
      Booking.aggregate([
        { $match: paidIn(win.from, win.to) },
        { $group: { _id: bucketOf(win, '$payment.paidAt'), amount: { $sum: billExpr } } },
      ]),
      Booking.countDocuments(made(win.prevFrom, win.from)),
      sum(paidIn(win.from, win.to)),
      sum(paidIn(win.prevFrom, win.from)),
      Booking.aggregate([{ $match: made(win.from, win.to) }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      Booking.aggregate([
        { $match: made(win.from, win.to) },
        { $group: { _id: { $ifNull: ['$serviceSubCategory', '$serviceCategory'] }, n: { $sum: 1 } } },
      ]),
      ProviderReview.aggregate([{ $match: { provider: id } }, { $group: { _id: '$rating', n: { $sum: 1 } } }]),
      outcomeStats(id),
      onTimeRate(id),
      repeatCustomerRate(id),
      // Average job length: started → completed, over completed jobs in range.
      Booking.aggregate([
        { $match: { provider: id, status: STATUS.COMPLETED, updatedAt: { $gte: win.from, $lt: win.to } } },
        {
          $project: {
            started: { $arrayElemAt: [{ $filter: { input: '$statusHistory', cond: { $eq: ['$$this.status', STATUS.IN_PROGRESS] } } }, 0] },
            done: { $arrayElemAt: [{ $filter: { input: '$statusHistory', cond: { $eq: ['$$this.status', STATUS.COMPLETED] } } }, 0] },
          },
        },
        { $match: { 'started.changedAt': { $type: 'date' }, 'done.changedAt': { $type: 'date' } } },
        { $group: { _id: null, ms: { $avg: { $subtract: ['$done.changedAt', '$started.changedAt'] } } } },
      ]),
      Booking.find({ provider: id })
        .sort({ createdAt: -1 })
        .limit(RECENT)
        .populate('customer', 'fullName')
        .select('status serviceCategory serviceSubCategory scheduledFor createdAt pricing payment customer')
        .lean(),
    ]);

  const jobs = countRows.reduce((s, r) => s + r.n, 0);
  const paidNow = Math.round(cur[0]?.amount || 0);
  const paidBefore = Math.round(prev[0]?.amount || 0);
  const ratingCount = ratingRows.reduce((s, r) => s + r.n, 0);
  const ratingAvg = ratingCount ? Math.round((ratingRows.reduce((s, r) => s + r._id * r.n, 0) / ratingCount) * 10) / 10 : null;
  const statusCounts = Object.fromEntries(byStatus.map((r) => [r._id, r.n]));
  const cancelled = (statusCounts[STATUS.CANCELLED] || 0) + (statusCounts[STATUS.REJECTED] || 0);

  return {
    seriesLabels: { count: 'Jobs', amount: 'Paid' },
    summary: [
      ranged('jobs', 'Jobs', jobs, prevJobs, 'count'),
      ranged('paid', 'Paid', paidNow, paidBefore, WALLET_CURRENCY),
      metric('completed', 'Completed', cur[0]?.n || 0, 'count', 'range'),
      metric('cancellation_rate', 'Cancelled or declined', pct(cancelled, jobs), 'percent', 'range'),
      metric('completion_rate', 'Completion rate', outcomes.completionRate, 'percent', 'all_time'),
      metric('on_time_rate', 'On time', onTime, 'percent', 'all_time'),
      metric('repeat_customers', 'Repeat customers', repeat, 'percent', 'all_time'),
      metric('rating', 'Rating', ratingAvg, 'rating', 'all_time', { count: ratingCount }),
      metric(
        'avg_job_minutes',
        'Average job length',
        lengthRows[0] ? Math.round(lengthRows[0].ms / 60000) : null,
        'minutes',
        'range'
      ),
    ],
    series: fillSeries(win, countRows, amountRows),
    breakdowns: [
      { key: 'status', label: 'Jobs by status', rows: rowsOf(Object.entries(statusCounts)) },
      { key: 'category', label: 'Jobs by service', rows: rowsOf(byCategory.map((r) => [r._id || 'other', r.n])) },
      {
        key: 'rating',
        label: 'Ratings',
        rows: [5, 4, 3, 2, 1].map((star) => ({
          key: String(star),
          label: `${star} star${star === 1 ? '' : 's'}`,
          value: ratingRows.find((r) => r._id === star)?.n || 0,
        })),
      },
    ],
    recent: recent.map((b) => ({
      kind: 'booking',
      id: String(b._id),
      title: humanise(b.serviceSubCategory || b.serviceCategory),
      subtitle: b.customer?.fullName || null,
      status: b.status,
      amount: b.payment?.status === 'paid' ? Math.round(b.payment.requestedAmount || b.pricing?.finalPrice || b.pricing?.estimatedPrice || 0) : null,
      at: b.scheduledFor || b.createdAt,
    })),
    links: {},
  };
}

// ── Doctors ───────────────────────────────────────────────────────────────

async function doctor(provider, win) {
  const doc = await Doctor.findOne({ providerId: provider._id }).select('_id rating totalReviews isAvailable').lean();
  if (!doc) return emptyFor(win, { count: 'Appointments', amount: 'Paid' });
  const id = doc._id;
  const made = (from, to) => ({ doctorId: id, createdAt: { $gte: from, $lt: to } });
  const doneIn = (from, to) => ({ doctorId: id, status: 'completed', completedAt: { $gte: from, $lt: to } });
  const paidAmount = { $ifNull: ['$payout.amount', '$payment.amount'] };
  const sum = (match) =>
    Appointment.aggregate([{ $match: match }, { $group: { _id: null, amount: { $sum: paidAmount }, n: { $sum: 1 } } }]);

  const [countRows, amountRows, prevCount, cur, prev, byStatus, byType, upcoming, clinics, recent] = await Promise.all([
    Appointment.aggregate([{ $match: made(win.from, win.to) }, { $group: { _id: bucketOf(win, '$createdAt'), n: { $sum: 1 } } }]),
    Appointment.aggregate([
      { $match: doneIn(win.from, win.to) },
      { $group: { _id: bucketOf(win, '$completedAt'), amount: { $sum: paidAmount } } },
    ]),
    Appointment.countDocuments(made(win.prevFrom, win.from)),
    sum(doneIn(win.from, win.to)),
    sum(doneIn(win.prevFrom, win.from)),
    Appointment.aggregate([{ $match: made(win.from, win.to) }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Appointment.aggregate([{ $match: made(win.from, win.to) }, { $group: { _id: '$type', n: { $sum: 1 } } }]),
    Appointment.countDocuments({ doctorId: id, status: { $in: ['pending', 'confirmed'] }, startUtc: { $gte: new Date() } }),
    Clinic.countDocuments({ doctorId: id }),
    Appointment.find({ doctorId: id })
      .sort({ createdAt: -1 })
      .limit(RECENT)
      .populate('patientId', 'fullName')
      .select('status type startUtc createdAt payment patientId patientInfo')
      .lean(),
  ]);

  const made_ = countRows.reduce((s, r) => s + r.n, 0);
  const statusCounts = Object.fromEntries(byStatus.map((r) => [r._id, r.n]));
  return {
    seriesLabels: { count: 'Appointments', amount: 'Paid' },
    summary: [
      ranged('appointments', 'Appointments', made_, prevCount, 'count'),
      ranged('paid', 'Paid', Math.round(cur[0]?.amount || 0), Math.round(prev[0]?.amount || 0), WALLET_CURRENCY),
      metric('completed', 'Completed', cur[0]?.n || 0, 'count', 'range'),
      metric('cancellation_rate', 'Cancelled', pct(statusCounts.cancelled || 0, made_), 'percent', 'range'),
      metric('upcoming', 'Upcoming', upcoming, 'count', 'now'),
      metric('rating', 'Rating', doc.totalReviews ? Math.round((doc.rating || 0) * 10) / 10 : null, 'rating', 'all_time', {
        count: doc.totalReviews || 0,
      }),
      metric('clinics', 'Clinics', clinics, 'count', 'now'),
    ],
    series: fillSeries(win, countRows, amountRows),
    breakdowns: [
      { key: 'status', label: 'Appointments by status', rows: rowsOf(Object.entries(statusCounts)) },
      {
        key: 'type',
        label: 'Appointments by type',
        rows: rowsOf(byType.map((r) => [r._id, r.n]), { 'in-clinic': 'In clinic', video: 'Video' }),
      },
    ],
    recent: recent.map((a) => ({
      kind: 'appointment',
      id: String(a._id),
      title: a.type === 'video' ? 'Video consultation' : 'Clinic visit',
      subtitle: a.patientId?.fullName || a.patientInfo?.name || null,
      status: a.status,
      amount: a.payment?.status === 'paid' ? Math.round(a.payment.amount || 0) : null,
      at: a.startUtc || a.createdAt,
    })),
    links: { doctorId: String(id) },
  };
}

// ── Shopping vendors ──────────────────────────────────────────────────────

const SOLD = ['confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered'];

async function vendor(provider, win) {
  const brands = await Brand.find({ owner: provider._id, isDeleted: { $ne: true } }).select('_id name').lean();
  if (!brands.length) return emptyFor(win, { count: 'Orders', amount: 'Delivered' });
  const ids = brands.map((b) => b._id);
  const made = (from, to) => ({ brandId: { $in: ids }, createdAt: { $gte: from, $lt: to } });
  const deliveredIn = (from, to) => ({ brandId: { $in: ids }, orderStatus: 'delivered', deliveredAt: { $gte: from, $lt: to } });
  const sum = (match) => Order.aggregate([{ $match: match }, { $group: { _id: null, amount: { $sum: '$total' }, n: { $sum: 1 } } }]);

  const [countRows, amountRows, prevCount, cur, prev, byStatus, topProducts, products, recent] = await Promise.all([
    Order.aggregate([{ $match: made(win.from, win.to) }, { $group: { _id: bucketOf(win, '$createdAt'), n: { $sum: 1 } } }]),
    Order.aggregate([
      { $match: deliveredIn(win.from, win.to) },
      { $group: { _id: bucketOf(win, '$deliveredAt'), amount: { $sum: '$total' } } },
    ]),
    Order.countDocuments(made(win.prevFrom, win.from)),
    sum(deliveredIn(win.from, win.to)),
    sum(deliveredIn(win.prevFrom, win.from)),
    Order.aggregate([{ $match: made(win.from, win.to) }, { $group: { _id: '$orderStatus', n: { $sum: 1 } } }]),
    Order.aggregate([
      { $match: { ...made(win.from, win.to), orderStatus: { $in: SOLD } } },
      { $unwind: '$items' },
      { $group: { _id: '$items.productName', revenue: { $sum: '$items.totalPrice' } } },
      { $sort: { revenue: -1 } },
      { $limit: 5 },
    ]),
    Product.countDocuments({ brandId: { $in: ids } }),
    Order.find({ brandId: { $in: ids } })
      .sort({ createdAt: -1 })
      .limit(RECENT)
      .select('odexId orderStatus total createdAt items shippingAddress.fullName')
      .lean(),
  ]);

  const orders = countRows.reduce((s, r) => s + r.n, 0);
  const statusCounts = Object.fromEntries(byStatus.map((r) => [r._id, r.n]));
  const returned = (statusCounts.returned || 0) + (statusCounts.refunded || 0);
  return {
    seriesLabels: { count: 'Orders', amount: 'Delivered' },
    summary: [
      ranged('orders', 'Orders', orders, prevCount, 'count'),
      ranged('delivered_value', 'Delivered', Math.round(cur[0]?.amount || 0), Math.round(prev[0]?.amount || 0), WALLET_CURRENCY),
      metric('delivered', 'Orders delivered', cur[0]?.n || 0, 'count', 'range'),
      metric('return_rate', 'Returned', pct(returned, orders), 'percent', 'range'),
      metric('avg_order_value', 'Average order', cur[0]?.n ? Math.round(cur[0].amount / cur[0].n) : null, WALLET_CURRENCY, 'range'),
      metric('products', 'Products', products, 'count', 'now'),
    ],
    series: fillSeries(win, countRows, amountRows),
    breakdowns: [
      { key: 'status', label: 'Orders by status', rows: rowsOf(Object.entries(statusCounts)) },
      {
        key: 'products',
        label: 'Top products',
        unit: WALLET_CURRENCY,
        rows: topProducts.map((p) => ({ key: p._id, label: p._id, value: Math.round(p.revenue) })),
      },
    ],
    recent: recent.map((o) => ({
      kind: 'order',
      id: String(o._id),
      title: `Order ${o.odexId || String(o._id).slice(-6)}`,
      subtitle: `${o.items?.length || 0} item${o.items?.length === 1 ? '' : 's'}${o.shippingAddress?.fullName ? ` · ${o.shippingAddress.fullName}` : ''}`,
      status: o.orderStatus,
      amount: Math.round(o.total || 0),
      at: o.createdAt,
    })),
    links: { brandIds: ids.map(String), brands: brands.map((b) => ({ id: String(b._id), name: b.name })) },
  };
}

function emptyFor(win, seriesLabels) {
  return { seriesLabels, summary: [], series: fillSeries(win, [], []), breakdowns: [], recent: [], links: {} };
}

const BUILDERS = { home_service: homeService, doctor, vendor };

/**
 * @param provider a Provider document (or lean object)
 * @param {string} range one of RANGES
 */
async function providerAnalytics(provider, range = DEFAULT_RANGE, now = new Date()) {
  const win = windowOf(range, now);
  const id = new mongoose.Types.ObjectId(String(provider._id));
  const build = BUILDERS[provider.providerType] || ((_, w) => emptyFor(w, { count: 'Activity', amount: 'Paid' }));
  const [body, wallet] = await Promise.all([build({ ...provider, _id: id }, win), walletOf(id)]);
  return {
    providerId: String(id),
    type: provider.providerType,
    range,
    rangeLabel: win.label,
    bucket: win.bucket,
    from: win.from,
    to: win.to,
    ...body,
    wallet,
  };
}

module.exports = { providerAnalytics, windowOf, RANGES, DEFAULT_RANGE };
