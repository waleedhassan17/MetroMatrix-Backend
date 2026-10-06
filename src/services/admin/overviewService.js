const User = require('../../models/User');
const Provider = require('../../models/Provider');
const AdminAuditLog = require('../../models/AdminAuditLog');
const { monthWindows, growthPct, DEFAULT_TIMEZONE } = require('../../utils/time');
const { WALLET_CURRENCY } = require('../../config/currency');
const { stateFilter } = require('./providerStatus');
const { queueSummary } = require('./queueService');
const { computeReconciliation } = require('../walletReconciliation');
const { homeserviceDashboard } = require('../../modules/homeservice/services/adminDashboardService');
const { healthcareDashboard } = require('../../modules/healthcare/services/adminDashboardService');
const { shoppingDashboard } = require('../../modules/shopping/services/adminDashboardService');
const logger = require('../../utils/logger');

/**
 * GET /api/admin/overview — the admin home screen in one call.
 *
 *  queues        what is waiting for this admin (only types they may act on)
 *  kpis          platform figures, each with its period; growth is null when
 *                there is nothing to compare with (never an invented trend)
 *  verticals     each module the admin may see, composed from that module's
 *                own dashboard service. A module that fails or is slow comes
 *                back `status: 'unavailable'` — the rest of the page still
 *                renders.
 *  recentActivity  latest audit entries (everyone's with canViewAudit, else
 *                the admin's own)
 */
const VERTICAL_TIMEOUT_MS = 4000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const metric = (key, label, value, unit, period, extra = {}) => ({ key, label, value, unit, period, ...extra });

const VERTICALS = {
  homeservice: {
    label: 'Home services',
    permission: 'canManageHomeServices',
    load: homeserviceDashboard,
    headline: (d) => [
      metric('bookings_today', 'Bookings today', d.bookingsToday, 'count', 'today'),
      metric('gmv_today', 'Paid today', d.gmvToday, WALLET_CURRENCY, 'today'),
      metric('open_disputes', 'Open disputes', d.openDisputes, 'count', 'now'),
      metric('providers_online', 'Providers online', d.activeProvidersOnline, 'count', 'now'),
    ],
  },
  healthcare: {
    label: 'Healthcare',
    permission: 'canManageHealthcare',
    load: healthcareDashboard,
    headline: (d) => [
      metric('appointments_today', 'Appointments booked today', d.appointmentsToday, 'count', 'today'),
      metric('revenue_today', 'Consultation payments today', d.revenueToday, WALLET_CURRENCY, 'today'),
      metric('cancellation_rate', 'Cancellation rate', d.cancellationRate, 'percent', 'all_time'),
      metric('pending_doctors', 'Doctors awaiting verification', d.pendingDoctorApprovals, 'count', 'now'),
    ],
  },
  shopping: {
    label: 'Shopping',
    permission: 'canManageShopping',
    load: shoppingDashboard,
    headline: (d) => [
      metric('orders_today', 'Orders today', d.ordersToday, 'count', 'today'),
      metric('gmv_today', 'Order value today', d.gmvToday, WALLET_CURRENCY, 'today'),
      metric('open_returns', 'Open returns', d.openReturnRequests, 'count', 'now'),
      metric('low_stock', 'Variants running low', d.lowStockAlerts, 'count', 'now'),
    ],
  },
};

async function coreKpis(now) {
  const w = monthWindows(now);
  const inWindow = (win) => ({ createdAt: { $gte: win.from, $lt: win.to } });
  const [usersTotal, usersThis, usersBase, providersApproved, providersThis, providersBase] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments(inWindow(w.thisMonth)),
    User.countDocuments(inWindow(w.samePeriodLastMonth)),
    Provider.countDocuments(stateFilter('approved')),
    Provider.countDocuments(inWindow(w.thisMonth)),
    Provider.countDocuments(inWindow(w.samePeriodLastMonth)),
  ]);
  return [
    metric('users_total', 'Customers', usersTotal, 'count', 'all_time'),
    metric('users_new', 'New customers this month', usersThis, 'count', 'month_to_date', {
      delta: growthPct(usersThis, usersBase),
      comparedTo: 'same_period_last_month',
    }),
    metric('providers_approved', 'Approved providers', providersApproved, 'count', 'all_time'),
    metric('providers_new', 'Provider sign-ups this month', providersThis, 'count', 'month_to_date', {
      delta: growthPct(providersThis, providersBase),
      comparedTo: 'same_period_last_month',
    }),
  ];
}

async function verticalsFor(admin, now) {
  const visible = Object.entries(VERTICALS).filter(([, v]) => admin.hasPermission(v.permission));
  const settled = await Promise.allSettled(visible.map(([, v]) => withTimeout(v.load(now), VERTICAL_TIMEOUT_MS)));
  return Object.fromEntries(
    visible.map(([key, v], i) => {
      const r = settled[i];
      if (r.status === 'fulfilled') return [key, { label: v.label, status: 'ok', headline: v.headline(r.value) }];
      logger.warn({ err: r.reason, vertical: key }, 'overview vertical unavailable');
      return [key, { label: v.label, status: 'unavailable', headline: [] }];
    })
  );
}

async function reconciliationQueue(admin) {
  if (!admin.hasPermission('canManageFinance')) return null;
  try {
    const r = await withTimeout(computeReconciliation(), VERTICAL_TIMEOUT_MS);
    if (!r.balanced) await require('../notificationService').notifyReconciliationDrift(r);
    return {
      type: 'reconciliation_drift',
      label: 'Wallet ledger out of balance',
      count: r.balanced ? 0 : 1,
      oldestAt: null,
      requiredPermission: 'canManageFinance',
      detail: { drift: r.drift, currency: WALLET_CURRENCY },
    };
  } catch (err) {
    logger.warn({ err }, 'overview reconciliation unavailable');
    return { type: 'reconciliation_drift', label: 'Wallet ledger check', count: null, oldestAt: null, status: 'unavailable', requiredPermission: 'canManageFinance' };
  }
}

async function recentActivity(admin, limit = 8) {
  const filter = { action: { $not: /^admin\.login\.(succeeded|failed|blocked)$/ } };
  if (!admin.hasPermission('canViewAudit')) filter.actor = admin._id;
  const rows = await AdminAuditLog.find(filter).sort({ createdAt: -1 }).limit(limit).populate('actor', 'fullName').lean();
  return rows.map((r) => ({
    id: String(r._id),
    action: r.action,
    module: r.module,
    actor: r.actor ? { id: String(r.actor._id), name: r.actor.fullName } : null,
    target: r.targetType ? { type: r.targetType, id: r.targetId ? String(r.targetId) : null } : null,
    reason: r.reason || null,
    createdAt: r.createdAt,
  }));
}

async function overview(admin, now = new Date()) {
  const [queues, recon, kpis, verticals, activity] = await Promise.all([
    queueSummary(admin),
    reconciliationQueue(admin),
    coreKpis(now),
    verticalsFor(admin, now),
    recentActivity(admin),
  ]);
  return {
    generatedAt: now.toISOString(),
    timezone: DEFAULT_TIMEZONE,
    currency: WALLET_CURRENCY,
    queues: recon ? [...queues, recon] : queues,
    kpis,
    verticals,
    recentActivity: activity,
  };
}

module.exports = { overview, VERTICALS, coreKpis };
