const asyncHandler = require('express-async-handler');
const User = require('../../models/User');
const Provider = require('../../models/Provider');
const Post = require('../../models/Post');
const Doctor = require('../../modules/healthcare/models/Doctor');
const Specialty = require('../../modules/healthcare/models/Specialty');
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
 *
 * Alongside the range it carries the all-time picture the admin home charts:
 *   users.total, providers.total     everyone registered now
 *   users.before, providers.before   registered before `from`: a running
 *                                    total across the range starts here
 *   providers.types[]                one entry per provider type — doctor,
 *                                    home_service, vendor, and pending (type
 *                                    not chosen yet): all-time total and
 *                                    states, sign-ups in the range by day, and
 *                                    what the type is made of (doctors by
 *                                    specialty, home service by trade, vendors
 *                                    by category; the top six, the rest summed
 *                                    as `other`)
 */
const MAX_DAYS = 366;
const PROVIDER_TYPES = ['doctor', 'home_service', 'vendor', 'pending'];
const BREAKDOWN_TOP = 6;
const BREAKDOWN_FIELD = { doctor: 'specialty', home_service: 'providerSubType', vendor: 'category' };

// A provider with no type, or one this list does not know, has not chosen yet.
const typeKey = (type) => (PROVIDER_TYPES.includes(type) ? type : 'pending');

const DAY_KEY = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: DEFAULT_TIMEZONE } };

// stateOf() in services/admin/providerStatus.js, as an aggregation expression,
// so every provider lands in exactly one state and the states add up to the total.
const STATE_EXPR = {
  $switch: {
    branches: [
      { case: { $eq: ['$isSuspended', true] }, then: 'suspended' },
      { case: { $eq: ['$verificationStatus', 'approved'] }, then: 'approved' },
      { case: { $eq: ['$verificationStatus', 'rejected'] }, then: 'rejected' },
      { case: { $ne: [{ $ifNull: ['$submittedAt', null] }, null] }, then: 'pending' },
    ],
    default: 'incomplete',
  },
};

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

function fillDays(byDay, from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, count: byDay.get(d) || 0 });
  return out;
}

async function dailySeries(Model, window, from, to) {
  const rows = await Model.aggregate([
    { $match: { createdAt: { $gte: window.from, $lt: window.to } } },
    { $group: { _id: DAY_KEY, count: { $sum: 1 } } },
  ]);
  return fillDays(new Map(rows.map((r) => [r._id, r.count])), from, to);
}

/** Each provider type's sign-ups per day across the range. */
async function dailyByType(window, from, to) {
  const rows = await Provider.aggregate([
    { $match: { createdAt: { $gte: window.from, $lt: window.to } } },
    { $group: { _id: { day: DAY_KEY, type: '$providerType' }, count: { $sum: 1 } } },
  ]);
  const days = new Map(PROVIDER_TYPES.map((t) => [t, new Map()]));
  for (const r of rows) {
    const byDay = days.get(typeKey(r._id.type));
    byDay.set(r._id.day, (byDay.get(r._id.day) || 0) + r.count);
  }
  return new Map(PROVIDER_TYPES.map((t) => [t, fillDays(days.get(t), from, to)]));
}

/** Every provider now, counted by type and state. */
async function statesByType() {
  const rows = await Provider.aggregate([{ $group: { _id: { type: '$providerType', state: STATE_EXPR }, count: { $sum: 1 } } }]);
  const states = new Map(PROVIDER_TYPES.map((t) => [t, Object.fromEntries(status.PROVIDER_STATES.map((s) => [s, 0]))]));
  for (const r of rows) states.get(typeKey(r._id.type))[r._id.state] += r.count;
  return states;
}

// The value each type is broken down by. A doctor's specialty lives on their
// healthcare Doctor record; the provider's own `specialty` text is the fallback.
const BREAKDOWN_VALUE = {
  doctor: [
    { $lookup: { from: Doctor.collection.name, localField: '_id', foreignField: 'providerId', as: 'doctorRecord' } },
    { $lookup: { from: Specialty.collection.name, localField: 'doctorRecord.specialtyId', foreignField: '_id', as: 'specialtyRecord' } },
    { $project: { value: { $ifNull: [{ $arrayElemAt: ['$specialtyRecord.name', 0] }, '$specialty'] } } },
  ],
  home_service: [{ $project: { value: '$providerSubType' } }],
  vendor: [{ $project: { value: '$category' } }],
};

/**
 * What one type is made of, all time: the top values (compared ignoring case
 * and surrounding spaces, shown as first spelled) and the rest summed as
 * `other`. A provider with nothing set counts under key null.
 */
async function breakdown(type) {
  const rows = await Provider.aggregate([
    { $match: { providerType: type } },
    ...BREAKDOWN_VALUE[type],
    {
      $group: {
        _id: { $toLower: { $trim: { input: { $ifNull: [{ $toString: '$value' }, ''] } } } },
        label: { $first: '$value' },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1, _id: 1 } },
  ]);
  return {
    field: BREAKDOWN_FIELD[type],
    items: rows.slice(0, BREAKDOWN_TOP).map((r) => ({ key: r._id || null, label: r._id ? String(r.label).trim() : null, count: r.count })),
    other: rows.slice(BREAKDOWN_TOP).reduce((n, r) => n + r.count, 0),
  };
}

const BROKEN_DOWN = Object.keys(BREAKDOWN_FIELD);

const getAnalytics = asyncHandler(async (req, res) => {
  const { from, to, window } = rangeFrom(req.query);
  const created = { createdAt: { $gte: window.from, $lt: window.to } };
  const since = { createdAt: { $gte: window.from } };

  const [
    [usersNew, usersActive, providersNew, byType, states, postsNew, userSeries, providerSeries],
    [usersTotal, usersSince, providersSince, typeDaily, typeStates, breakdowns],
  ] = await Promise.all([
    Promise.all([
      User.countDocuments(created),
      User.countDocuments({ ...created, isActive: { $ne: false } }),
      Provider.countDocuments(created),
      Provider.aggregate([{ $match: created }, { $group: { _id: '$providerType', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
      Promise.all(status.PROVIDER_STATES.map(async (s) => ({ state: s, count: await Provider.countDocuments({ ...created, ...status.stateFilter(s) }) }))),
      Post.countDocuments(created),
      dailySeries(User, window, from, to),
      dailySeries(Provider, window, from, to),
    ]),
    Promise.all([
      User.countDocuments({}),
      User.countDocuments(since),
      Provider.countDocuments(since),
      dailyByType(window, from, to),
      statesByType(),
      Promise.all(BROKEN_DOWN.map(breakdown)),
    ]),
  ]);

  const types = PROVIDER_TYPES.map((type) => {
    const byState = typeStates.get(type);
    const daily = typeDaily.get(type);
    return {
      type,
      total: Object.values(byState).reduce((n, c) => n + c, 0),
      byState,
      registered: daily.reduce((n, d) => n + d.count, 0),
      daily,
      breakdown: BROKEN_DOWN.includes(type) ? breakdowns[BROKEN_DOWN.indexOf(type)] : null,
    };
  });
  const providersTotal = types.reduce((n, t) => n + t.total, 0);

  ok(res, {
    range: { from, to, timezone: DEFAULT_TIMEZONE },
    users: {
      registered: usersNew,
      stillActive: usersActive,
      daily: userSeries,
      total: usersTotal,
      // Everyone not registered inside or after the range — including any old
      // account with no createdAt — so a running total ends at `total`.
      before: usersTotal - usersSince,
    },
    providers: {
      registered: providersNew,
      byType: byType.map((t) => ({ type: t._id, count: t.count })),
      byState: states,
      daily: providerSeries,
      total: providersTotal,
      before: providersTotal - providersSince,
      types,
    },
    posts: { created: postsNew },
  });
});

module.exports = { getAnalytics };
