const { DateTime } = require('luxon');
const {
  DEFAULT_TIMEZONE,
  safeZone,
  isDateKey,
  paddedRange,
  toDateKey,
  addDays,
  localToUtc,
  startOfWeekKey,
  startOfMonthKey,
  addMonthsKey,
  daysBetween,
} = require('../../../utils/time');
const { appointmentTimeFields } = require('./appointmentTime');

// ============================================================================
// The doctor app's read queries: appointment lists, dashboard, earnings.
//
// Everything here filters on the appointment's OWN copied time (startUtc +
// dateKey), so each query is one indexed read. The versions these replace
// loaded a doctor's entire appointment history — or $lookup-ed slots across
// all of it — and filtered by date in JavaScript, on every Schedule open and
// every 30-second queue poll.
//
// The builders are pure so they can be tested without a database.
// ============================================================================

const ACTIVE_STATUSES = ['pending', 'confirmed'];
const MAX_LIST_LIMIT = 200;
const MAX_CUSTOM_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What an appointment list row needs — not payment ledger internals. */
const APPOINTMENT_LIST_FIELDS = [
  'patientId',
  'doctorId',
  'slotId',
  'clinicId',
  'type',
  'status',
  'patientInfo',
  'symptoms',
  'fee',
  'discount',
  'totalAmount',
  'payment.status',
  'payment.method',
  'cancellationReason',
  'cancelledBy',
  'completedAt',
  'createdAt',
  'startUtc',
  'endUtc',
  'dateKey',
  'startTime',
  'endTime',
  'timezone',
].join(' ');

class QueryInputError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

/**
 * Mongo filter + sort for GET /doctors/me/appointments.
 *
 * @param {object} query `{ status, date, from, to }` from the request
 * @returns {{ filter: object, sort: object }}
 */
function buildDoctorAppointmentFilter(doctorId, query = {}, { tz = DEFAULT_TIMEZONE, now = new Date() } = {}) {
  const zone = safeZone(tz);
  const today = toDateKey(now, zone);
  const filter = { doctorId };
  let sort = { startUtc: -1, _id: -1 };

  if (query.date || query.from || query.to) {
    const fromKey = query.date || query.from || query.to;
    const toKey = query.date || query.to || fromKey;
    if (!isDateKey(fromKey) || !isDateKey(toKey)) {
      throw new QueryInputError('date, from and to must be YYYY-MM-DD');
    }
    const range = paddedRange(fromKey, toKey, zone);
    if (!range) throw new QueryInputError('to must not be before from');
    if (daysBetween(fromKey, toKey) >= MAX_CUSTOM_DAYS) {
      throw new QueryInputError(`A range can cover at most ${MAX_CUSTOM_DAYS} days`);
    }
    Object.assign(filter, range);
    // A calendar reads forwards.
    sort = { startUtc: 1, _id: 1 };
  }

  switch (query.status) {
    case 'upcoming':
      filter.status = { $in: ACTIVE_STATUSES };
      if (!filter.dateKey) {
        filter.startUtc = { $gte: paddedRange(today, today, zone).startUtc.$gte };
        filter.dateKey = { $gte: today };
        sort = { startUtc: 1, _id: 1 };
      }
      break;
    case 'past':
      filter.$or = [
        { status: 'completed' },
        { status: { $in: ACTIVE_STATUSES }, dateKey: { $lt: today } },
      ];
      break;
    case 'pending':
    case 'confirmed':
    case 'completed':
    case 'cancelled':
      filter.status = query.status;
      break;
    default:
      // No status, 'all', or something unknown: every status, as before.
      break;
  }

  return { filter, sort };
}

const withId = (doc) => (doc && typeof doc === 'object' && doc._id ? { ...doc, id: doc._id } : doc);

/**
 * A lean appointment in the shape the app already reads.
 *
 * Lean documents skip the model's toJSON, so `id` is added by hand. `slotId`
 * is rebuilt from the copied time for app builds that read the populated slot
 * (`slotId.date` = clinic midnight, `slotId.startTime`, …) — the slot itself
 * is no longer populated.
 */
function toAppointmentListItem(a) {
  if (!a) return a;
  const tz = safeZone(a.timezone);
  const slotRef = a.slotId && a.slotId._id ? a.slotId._id : a.slotId;
  return {
    ...a,
    id: a._id,
    patientId: withId(a.patientId),
    clinicId: withId(a.clinicId),
    slotId: a.dateKey
      ? {
          _id: slotRef,
          id: slotRef,
          date: localToUtc(a.dateKey, '00:00', tz),
          dateKey: a.dateKey,
          startTime: a.startTime,
          endTime: a.endTime,
          startUtc: a.startUtc,
          endUtc: a.endUtc,
          clinicTimezone: tz,
        }
      : a.slotId,
  };
}

/** The dashboard's appointment shape (what the app's dashboard serializer reads). */
function toDashboardItem(a) {
  const item = toAppointmentListItem(a);
  return {
    appointmentId: a._id,
    id: a._id,
    patientId: item.patientId,
    patientInfo: a.patientInfo,
    type: a.type,
    status: a.status,
    symptoms: a.symptoms,
    clinic: a.clinicId && a.clinicId.name ? { id: a.clinicId._id, name: a.clinicId.name } : null,
    date: item.slotId && item.slotId.date,
    dateKey: a.dateKey,
    timeSlot: { start: a.startTime, end: a.endTime },
    startUtc: a.startUtc,
    endUtc: a.endUtc,
    clinicTimezone: safeZone(a.timezone),
  };
}

/** Today, this week (Monday start) and this month, as keys in the doctor's zone. */
function computeDashboardWindows(now = new Date(), tz = DEFAULT_TIMEZONE) {
  const zone = safeZone(tz);
  const today = toDateKey(now, zone);
  return {
    todayKey: today,
    weekStartKey: startOfWeekKey(today, zone, 1),
    monthStartKey: startOfMonthKey(today),
  };
}

const EMPTY_DASHBOARD_STATS = { appointments: 0, completed: 0, upcoming: 0, pending: 0, cancelled: 0, earnings: 0 };

const DASHBOARD_GROUP = {
  $group: {
    _id: null,
    appointments: { $sum: 1 },
    completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
    upcoming: { $sum: { $cond: [{ $in: ['$status', ACTIVE_STATUSES] }, 1, 0] } },
    pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
    // The "Cancelled" tile was hardcoded to 0 in the app for want of this.
    cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
    earnings: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$totalAmount', 0] } },
  },
};

/** One `$facet` bucket's stats, or zeros. */
function pickStats(rows) {
  const row = rows && rows[0];
  if (!row) return { ...EMPTY_DASHBOARD_STATS };
  const { _id, ...stats } = row;
  return { ...EMPTY_DASHBOARD_STATS, ...stats };
}

const fmtKey = (key, format) => DateTime.fromISO(key, { zone: 'utc' }).toFormat(format);

/**
 * The window an earnings request covers, and the COMPLETE window before it.
 *
 * Named periods used to send no dates, so the server summed 1970–2100: "This
 * Month" was all-time earnings. And the app's "+12% vs last period" badge was a
 * hardcoded default, because nothing returned a previous total.
 *
 * @param {object} args `{ range, period, startDate, endDate, tz, now }`
 *   `range`: today | thisWeek | thisMonth | thisYear | custom. When absent the
 *   legacy `period` (daily/weekly/monthly/yearly) or explicit dates pick one.
 */
function resolveEarningsWindow({ range, period, startDate, endDate, tz = DEFAULT_TIMEZONE, now = new Date() } = {}) {
  const zone = safeZone(tz);
  const today = toDateKey(now, zone);
  const year = Number(today.slice(0, 4));

  let key = range;
  if (!key) {
    if (startDate || endDate) key = 'custom';
    else key = { daily: 'today', weekly: 'thisWeek', monthly: 'thisMonth', yearly: 'thisYear' }[period] || 'today';
  }

  let fromKey;
  let toKey;
  let prevFromKey;
  let prevToKey;
  let bucket = 'day';
  let label;
  let previousLabel;

  switch (key) {
    case 'today':
      fromKey = today;
      toKey = today;
      prevFromKey = addDays(today, -1, zone);
      prevToKey = prevFromKey;
      label = 'Today';
      previousLabel = 'Yesterday';
      break;
    case 'thisWeek':
      fromKey = startOfWeekKey(today, zone, 1);
      toKey = today;
      prevFromKey = addDays(fromKey, -7, zone);
      prevToKey = addDays(fromKey, -1, zone);
      label = 'This week';
      previousLabel = 'Last week';
      break;
    case 'thisMonth':
      fromKey = startOfMonthKey(today);
      toKey = today;
      prevFromKey = addMonthsKey(fromKey, -1, zone);
      prevToKey = addDays(fromKey, -1, zone);
      label = fmtKey(fromKey, 'LLLL yyyy');
      previousLabel = fmtKey(prevFromKey, 'LLLL yyyy');
      break;
    case 'thisYear':
      fromKey = `${year}-01-01`;
      toKey = today;
      prevFromKey = `${year - 1}-01-01`;
      prevToKey = `${year - 1}-12-31`;
      bucket = 'month';
      label = String(year);
      previousLabel = String(year - 1);
      break;
    case 'custom': {
      if (!isDateKey(startDate) || !isDateKey(endDate)) {
        throw new QueryInputError('startDate and endDate must be YYYY-MM-DD');
      }
      const span = daysBetween(startDate, endDate);
      if (span < 0) throw new QueryInputError('endDate must not be before startDate');
      if (span + 1 > MAX_CUSTOM_DAYS) {
        throw new QueryInputError(`A custom range can cover at most ${MAX_CUSTOM_DAYS} days`);
      }
      fromKey = startDate;
      toKey = endDate;
      prevToKey = addDays(fromKey, -1, zone);
      prevFromKey = addDays(fromKey, -(span + 1), zone);
      // A bar per day stops being readable past two months.
      bucket = span + 1 > 62 ? 'month' : 'day';
      label = `${fmtKey(fromKey, 'd LLL')} – ${fmtKey(toKey, 'd LLL yyyy')}`;
      previousLabel = `Previous ${span + 1} days`;
      break;
    }
    default:
      throw new QueryInputError(`Unknown earnings range "${key}"`);
  }

  return {
    key,
    period: bucket === 'month' ? 'monthly' : 'daily',
    bucket,
    fromKey,
    toKey,
    prevFromKey,
    prevToKey,
    label,
    previousLabel,
  };
}

/** Aggregation for GET /doctors/me/earnings over a resolved window. */
function buildEarningsPipeline(doctorId, window, tz = DEFAULT_TIMEZONE) {
  const bucketExpr = window.bucket === 'month' ? { $substrBytes: ['$dateKey', 0, 7] } : '$dateKey';
  return [
    {
      $match: {
        doctorId,
        status: 'completed',
        ...paddedRange(window.prevFromKey, window.toKey, safeZone(tz)),
      },
    },
    {
      $facet: {
        current: [
          { $match: { dateKey: { $gte: window.fromKey } } },
          {
            $group: {
              _id: { bucket: bucketExpr, type: '$type' },
              total: { $sum: '$totalAmount' },
              count: { $sum: 1 },
            },
          },
          {
            $group: {
              _id: '$_id.bucket',
              types: { $push: { type: '$_id.type', total: '$total', count: '$count' } },
              totalAmount: { $sum: '$total' },
              count: { $sum: '$count' },
            },
          },
          { $sort: { _id: 1 } },
        ],
        previous: [
          { $match: { dateKey: { $lte: window.prevToKey } } },
          { $group: { _id: null, total: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
        ],
      },
    },
  ];
}

/** Totals per consultation type across an earnings breakdown. */
function summarizeByType(breakdown = []) {
  const byType = new Map();
  for (const bucket of breakdown) {
    for (const t of bucket.types || []) {
      const entry = byType.get(t.type) || { type: t.type, total: 0, count: 0 };
      entry.total += t.total || 0;
      entry.count += t.count || 0;
      byType.set(t.type, entry);
    }
  }
  return [...byType.values()];
}

// Doctors whose appointments are known to carry their copied time, per server
// instance — so the check below costs one indexed query per doctor per
// instance, not one per request.
const healedDoctors = new Set();

/**
 * Copy the time onto any of this doctor's appointments that predate the field.
 *
 * The backfill script does this for everything; this covers appointments
 * written in the gap between deploying and running it, so a doctor's schedule
 * is never silently missing rows.
 */
async function ensureAppointmentTimes(doctorId) {
  const key = String(doctorId);
  if (healedDoctors.has(key)) return 0;

  const Appointment = require('../models/Appointment');
  const Slot = require('../models/Slot');

  const missing = await Appointment.find({ doctorId, startUtc: null }).select('_id slotId').limit(500).lean();
  if (missing.length) {
    const slots = await Slot.find({ _id: { $in: missing.map((m) => m.slotId).filter(Boolean) } })
      .select('date dateKey startTime endTime startUtc endUtc clinicTimezone')
      .lean();
    const byId = new Map(slots.map((s) => [String(s._id), s]));
    const ops = [];
    for (const m of missing) {
      const fields = appointmentTimeFields(byId.get(String(m.slotId)));
      if (fields.startUtc) {
        ops.push({ updateOne: { filter: { _id: m._id, startUtc: null }, update: { $set: fields } } });
      }
    }
    if (ops.length) await Appointment.bulkWrite(ops, { ordered: false });
  }

  // Marked even when some could not be healed (their slot is gone): retrying
  // those on every request would cost a query each time and fix nothing.
  healedDoctors.add(key);
  return missing.length;
}

module.exports = {
  ACTIVE_STATUSES,
  APPOINTMENT_LIST_FIELDS,
  DAY_MS,
  MAX_CUSTOM_DAYS,
  MAX_LIST_LIMIT,
  DASHBOARD_GROUP,
  EMPTY_DASHBOARD_STATS,
  QueryInputError,
  buildDoctorAppointmentFilter,
  buildEarningsPipeline,
  computeDashboardWindows,
  ensureAppointmentTimes,
  pickStats,
  resolveEarningsWindow,
  summarizeByType,
  toAppointmentListItem,
  toDashboardItem,
};
