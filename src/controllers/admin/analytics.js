const asyncHandler = require('express-async-handler');
const User = require('../../models/User');
const Provider = require('../../models/Provider');
const Post = require('../../models/Post');
const AppError = require('../../utils/AppError');
const { ERROR_CODES } = require('../../utils/errorCodes');
const { ok } = require('../../utils/apiResponse');
const { DEFAULT_TIMEZONE, isDateKey, dayWindow, todayKey, addDays, daysBetween } = require('../../utils/time');
const status = require('../../services/admin/providerStatus');

/*
 * GET /api/admin/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD   (canViewAnalytics)
 *
 * Registrations analytics for a date range (Asia/Karachi days, inclusive;
 * default the last 30 days, at most 366). Daily series are complete — days
 * with no sign-ups are present with 0 — so a chart never has to guess.
 * Provider states use the real state model (suspended is not "rejected").
 */
const MAX_DAYS = 366;

function rangeFrom(query) {
  const to = query.to || todayKey(DEFAULT_TIMEZONE);
  const from = query.from || addDays(to, -29);
  if (!isDateKey(from) || !isDateKey(to) || to < from) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'from/to must be YYYY-MM-DD dates with from ≤ to', {
      details: { fields: [{ field: 'from', message: 'Invalid range' }] },
    });
  }
  if (daysBetween(from, to) + 1 > MAX_DAYS) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `The range can be at most ${MAX_DAYS} days`);
  }
  return { from, to, window: { from: dayWindow(from).from, to: dayWindow(to).to } };
}

async function dailySeries(Model, window, from, to) {
  const rows = await Model.aggregate([
    { $match: { createdAt: { $gte: window.from, $lt: window.to } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: DEFAULT_TIMEZONE } }, count: { $sum: 1 } } },
  ]);
  const byDay = new Map(rows.map((r) => [r._id, r.count]));
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, count: byDay.get(d) || 0 });
  return out;
}

const getAnalytics = asyncHandler(async (req, res) => {
  const { from, to, window } = rangeFrom(req.query);
  const created = { createdAt: { $gte: window.from, $lt: window.to } };

  const [usersNew, usersActive, providersNew, byType, states, postsNew, userSeries, providerSeries] = await Promise.all([
    User.countDocuments(created),
    User.countDocuments({ ...created, isActive: { $ne: false } }),
    Provider.countDocuments(created),
    Provider.aggregate([{ $match: created }, { $group: { _id: '$providerType', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    Promise.all(status.PROVIDER_STATES.map(async (s) => ({ state: s, count: await Provider.countDocuments({ ...created, ...status.stateFilter(s) }) }))),
    Post.countDocuments(created),
    dailySeries(User, window, from, to),
    dailySeries(Provider, window, from, to),
  ]);

  ok(res, {
    range: { from, to, timezone: DEFAULT_TIMEZONE },
    users: { registered: usersNew, stillActive: usersActive, daily: userSeries },
    providers: {
      registered: providersNew,
      byType: byType.map((t) => ({ type: t._id, count: t.count })),
      byState: states,
      daily: providerSeries,
    },
    posts: { created: postsNew },
  });
});

module.exports = { getAnalytics };
