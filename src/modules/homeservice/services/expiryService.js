/**
 * Closing requests and bookings that time has overtaken.
 *
 * Nothing used to end a booking nobody acted on. The booking-confirmation
 * screen once ran its own five-minute countdown, but that expired the request
 * only on the phone that happened to be watching while the server kept it
 * live — so it was removed, and nothing replaced it. By September the live
 * database held 52 open bookings scheduled in the past, one provider had 21
 * dead requests in his queue, and because a customer may hold only one live
 * booking per provider, a single abandoned request blocked that customer from
 * ever booking that provider again.
 *
 * Two rules, both measured from the time the customer booked for:
 *
 *   PENDING   + 1 hour  — the provider never answered. There is no job to do
 *                         any more; the customer should look elsewhere.
 *   ACCEPTED  + 24 hours — the provider said yes but the job never started.
 *                         Generous on purpose: work that ran without anyone
 *                         tapping through the app can still be confirmed by
 *                         the customer the same day.
 *
 * Later states (EN_ROUTE onwards) are never touched: someone set off, and only
 * the people involved (or an admin) can say how that ended.
 *
 * Applied lazily — every list and every single-booking read runs expireStale()
 * for the rows it is about to show — plus a daily Vercel cron as a backstop.
 * Serverless has no timer of its own, and lazily means a stale row is closed
 * the moment anyone could see it.
 */
const Booking = require('../models/Booking');
const HSNotification = require('../models/HSNotification');
// Registered here, not assumed: the candidates query populates both parties,
// and a script that loads this service without the rest of the app (the data
// hygiene sweep) would otherwise fail with "Schema hasn't been registered".
require('../../../models/User');
require('../../../models/Provider');
const { STATUS } = require('./statusMap');

const HOUR_MS = 60 * 60 * 1000;
const BATCH_LIMIT = 200;
/** Above this many rows a publish per row is noise; the lists refetch anyway. */
const EMIT_LIMIT = 20;

function whenOf(b) {
  if (!b.scheduledFor) return 'the booked time';
  const day = new Date(b.scheduledFor).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'Asia/Karachi',
  });
  return b.scheduledTime ? `${day}, ${b.scheduledTime}` : day;
}

const nameOf = (ref, fallback) => (ref && ref.fullName) || fallback;
const serviceOf = (b) => String(b.serviceSubCategory || b.serviceCategory || 'service').toLowerCase();

const RULES = [
  {
    from: STATUS.PENDING,
    graceMs: HOUR_MS,
    code: 'expired_pending',
    reason: "The provider didn't respond before the booking time, so the request was closed automatically.",
    customer: (b) => ({
      title: 'Request expired',
      message: `${nameOf(b.provider, 'The provider')} didn't respond before ${whenOf(b)}. Your request was closed — you can book another provider.`,
    }),
    provider: (b) => ({
      title: 'Request expired',
      message: `The ${serviceOf(b)} request from ${nameOf(b.customer, 'a customer')} for ${whenOf(b)} expired before you responded.`,
    }),
  },
  {
    from: STATUS.ACCEPTED,
    graceMs: 24 * HOUR_MS,
    code: 'expired_accepted',
    reason: 'The booking time passed without the job starting, so the booking was closed automatically.',
    customer: (b) => ({
      title: 'Booking closed',
      message: `Your ${serviceOf(b)} booking for ${whenOf(b)} was closed because the job never started.`,
    }),
    provider: (b) => ({
      title: 'Booking closed',
      message: `The ${serviceOf(b)} job for ${nameOf(b.customer, 'your customer')} on ${whenOf(b)} was closed because it was never started.`,
    }),
  },
];

/**
 * Close every stale booking inside `scope` (e.g. { provider: id },
 * { customer: id }, { _id: id }). Never throws — a read must never fail
 * because tidying up failed. Returns the number of bookings closed.
 *
 * `opts.announce: false` closes rows without notifying anyone — for clearing
 * a months-old backlog, where a burst of "request expired" notices about
 * bookings nobody remembers would be noise, not news.
 */
async function expireStale(scope = {}, now = new Date(), opts = {}) {
  const announce = opts.announce !== false;
  let closedTotal = 0;
  try {
    for (const rule of RULES) {
      const cutoff = new Date(now.getTime() - rule.graceMs);
      const candidates = await Booking.find({
        ...scope,
        status: rule.from,
        scheduledFor: { $lt: cutoff },
      })
        .select('_id customer provider serviceCategory serviceSubCategory scheduledFor scheduledTime')
        .populate('customer', 'fullName')
        .populate('provider', 'fullName')
        .limit(BATCH_LIMIT)
        .lean();
      if (!candidates.length) continue;

      const ids = candidates.map((c) => c._id);
      // Conditional on the status we read, so a booking accepted in the same
      // instant is left alone. `cancellation.at` doubles as this run's
      // fingerprint for finding exactly the rows it closed.
      await Booking.updateMany(
        { _id: { $in: ids }, status: rule.from },
        {
          $set: {
            status: STATUS.CANCELLED,
            cancellation: { by: 'system', reason: rule.reason, at: now, code: rule.code },
          },
          $push: {
            statusHistory: {
              status: STATUS.CANCELLED,
              changedBy: { id: null, role: 'system' },
              changedAt: now,
              note: rule.reason,
            },
          },
          $inc: { __v: 1 },
        }
      );
      const closedRows = await Booking.find({
        _id: { $in: ids },
        'cancellation.code': rule.code,
        'cancellation.at': now,
      })
        .select('_id')
        .lean();
      const closed = new Set(closedRows.map((r) => String(r._id)));
      if (!closed.size) continue;
      closedTotal += closed.size;

      const closedBookings = candidates.filter((c) => closed.has(String(c._id)));
      console.log(`[expiry] closed ${closed.size} ${rule.from} booking(s) scope=${JSON.stringify(scope)}`);
      if (!announce) continue;

      const notifications = [];
      for (const b of closedBookings) {
        const data = { bookingId: String(b._id), roomType: 'homeservice', status: STATUS.CANCELLED };
        const c = rule.customer(b);
        const p = rule.provider(b);
        if (b.customer) {
          notifications.push({
            recipient: b.customer._id || b.customer,
            recipientRole: 'user',
            type: 'booking_cancelled',
            title: c.title,
            message: c.message,
            data,
          });
        }
        if (b.provider) {
          notifications.push({
            recipient: b.provider._id || b.provider,
            recipientRole: 'provider',
            type: 'booking_cancelled',
            title: p.title,
            message: p.message,
            data,
          });
        }
      }
      if (notifications.length) {
        await HSNotification.insertMany(notifications, { ordered: false }).catch((e) =>
          console.error(`[expiry] notifications failed: ${e.message}`)
        );
      }

      // Anyone watching one of these bookings right now sees it close.
      if (closedBookings.length <= EMIT_LIMIT) {
        const { emitToBooking } = require('../../../sockets');
        await Promise.allSettled(
          closedBookings.map((b) =>
            emitToBooking(b._id, 'booking_status_changed', {
              bookingId: String(b._id),
              roomId: String(b._id),
              status: STATUS.CANCELLED,
              changedAt: now.toISOString(),
            })
          )
        );
      }
    }
  } catch (e) {
    console.error(`[expiry] failed scope=${JSON.stringify(scope)}: ${e.message}`);
  }
  return closedTotal;
}

module.exports = { expireStale, RULES, HOUR_MS };
