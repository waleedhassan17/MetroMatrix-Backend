/**
 * "Right now" — the live-usage tiles on the admin dashboard.
 *
 * Every figure is a count over live state, read in parallel, cached 15 s in
 * Redis so a room full of admins refreshing does not multiply the load.
 * Sources:
 *   - MongoDB: providers available now, live bookings, appointments in the
 *     next hour, live video calls, orders in the last hour / today;
 *   - the realtime service: accounts with an open socket, by role, and calls
 *     in progress (GET /api/internal/stats);
 *   - Redis counters written by the gateway: API requests and 5xx per minute,
 *     and distinct accounts active in the last 5 minutes.
 * Any one source failing leaves its tiles null; the rest still answer.
 */
const { withRedis, k } = require('../../../lib/redis');
const { getOrSet } = require('../../../lib/cache');
const { minuteKey } = require('../../../gateway/accessLog');

const CACHE_SEC = 15;

async function realtimeServiceStats() {
  const url = process.env.REALTIME_URL;
  const key = process.env.INTERNAL_API_KEY;
  if (!url || !key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/internal/stats`, {
      headers: { 'x-internal-key': key },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json && json.data ? json.data : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function apiTraffic(now = new Date()) {
  const minutes = Array.from({ length: 5 }, (_, i) => minuteKey(new Date(now.getTime() - i * 60000)));
  const counts = await withRedis(async (r) => {
    const p = r.pipeline();
    minutes.forEach((m) => p.get(k('metrics', 'req', m)));
    minutes.forEach((m) => p.get(k('metrics', 'err', m)));
    ['user', 'provider', 'admin'].forEach((role) => p.zcount(k('rt', 'active', role), now.getTime() - 5 * 60000, '+inf'));
    return p.exec();
  }, null);
  if (!counts) return null;
  const n = (v) => Number(v) || 0;
  const req = counts.slice(0, 5).map(n);
  const err = counts.slice(5, 10).map(n);
  const [users, providers, admins] = counts.slice(10).map(n);
  const totalReq = req.reduce((a, b) => a + b, 0);
  return {
    requestsPerMinute: Math.round(totalReq / 5),
    errorRate: totalReq ? Math.round((err.reduce((a, b) => a + b, 0) / totalReq) * 1000) / 1000 : 0,
    activeAccounts5m: { user: users, provider: providers, admin: admins },
  };
}

async function databaseCounts(now = new Date()) {
  const Provider = require('../../../models/Provider');
  const Booking = require('../../homeservice/models/Booking');
  const Appointment = require('../../healthcare/models/Appointment');
  const VideoCall = require('../../healthcare/models/VideoCall');
  const Order = require('../../shopping/models/Order');
  const { availableNowExpr, nowInPakistan } = require('../../homeservice/services/discoveryPipeline');
  const { searchableProviderFilter } = require('../../homeservice/services/providerVisibility');
  const { getHomeserviceSettings } = require('../../homeservice/services/settingsService');

  const settings = await getHomeserviceSettings({ cached: true });
  const { dayKey, hhmm } = nowInPakistan(now);
  const staleCutoff = new Date(now.getTime() - (settings.onlineStaleMinutes || 30) * 60000);
  const pktMidnight = new Date(Date.UTC(...(() => {
    const w = new Date(now.getTime() + 5 * 3600000);
    return [w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()];
  })()) - 5 * 3600000);

  const safe = (p) => p.catch(() => null);
  const [available, bookingsByStatus, apptsNextHour, videoLive, ordersLastHour, ordersToday] = await Promise.all([
    safe(
      Provider.aggregate([
        { $match: searchableProviderFilter() },
        { $match: { $expr: availableNowExpr({ dayKey, hhmm, staleCutoff }) } },
        { $count: 'n' },
      ]).then((r) => (r[0] ? r[0].n : 0))
    ),
    safe(
      Booking.aggregate([
        { $match: { status: { $in: ['PENDING', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'] } } },
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ]).then((rows) => Object.fromEntries(rows.map((r) => [r._id, r.n])))
    ),
    safe(Appointment.countDocuments({ status: 'confirmed', startUtc: { $gte: now, $lte: new Date(now.getTime() + 3600000) } })),
    safe(VideoCall.countDocuments({ status: 'active' })),
    safe(Order.countDocuments({ createdAt: { $gte: new Date(now.getTime() - 3600000) } })),
    safe(Order.countDocuments({ createdAt: { $gte: pktMidnight } })),
  ]);
  return {
    homeservice: {
      providersAvailableNow: available,
      liveBookings: bookingsByStatus,
      onTheWayNow: bookingsByStatus ? (bookingsByStatus.EN_ROUTE || 0) : null,
      inProgressNow: bookingsByStatus ? (bookingsByStatus.IN_PROGRESS || 0) : null,
      waitingForProvider: bookingsByStatus ? (bookingsByStatus.PENDING || 0) : null,
    },
    healthcare: { appointmentsNextHour: apptsNextHour, videoCallsLive: videoLive },
    shopping: { ordersLastHour, ordersToday },
  };
}

async function getRealtimeOverview(now = new Date()) {
  return getOrSet(k('an', 'realtime'), CACHE_SEC, async () => {
    const [db, realtime, api] = await Promise.all([databaseCounts(now), realtimeServiceStats(), apiTraffic(now)]);
    return {
      at: now.toISOString(),
      ...db,
      online: realtime
        ? { accounts: realtime.onlineAccounts, byRole: realtime.onlineByRole, callsInProgress: realtime.activeCalls }
        : null,
      api,
    };
  });
}

module.exports = { getRealtimeOverview, apiTraffic, databaseCounts, realtimeServiceStats };
