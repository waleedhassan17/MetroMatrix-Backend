/**
 * A provider's track record, computed from bookings rather than counters.
 *
 * Every rate here is judged on what the PROVIDER did. The old figures divided
 * completed jobs by everything that ever ended, so a customer changing their
 * mind, or the platform releasing a request another provider won, counted
 * against the provider — and the new request-expiry pass would have sunk every
 * provider who had old unanswered requests. What counts against a provider:
 * declining (REJECTED) and accepting a job that then never started
 * (cancellation code 'expired_accepted').
 */
const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const { STATUS } = require('./statusMap');

/** Arrival within this long after the booked time counts as on time. */
const ON_TIME_GRACE_MS = 15 * 60 * 1000;

const asId = (id) => new mongoose.Types.ObjectId(String(id));

/**
 * @returns {Promise<{completed:number, declined:number, noShows:number,
 *   completionRate:number|null}>} completionRate is null with no track record.
 */
async function outcomeStats(providerId) {
  const rows = await Booking.aggregate([
    { $match: { provider: asId(providerId), status: { $in: [STATUS.COMPLETED, STATUS.REJECTED, STATUS.CANCELLED] } } },
    { $group: { _id: { status: '$status', code: '$cancellation.code' }, n: { $sum: 1 } } },
  ]);
  let completed = 0;
  let declined = 0;
  let noShows = 0;
  for (const r of rows) {
    if (r._id.status === STATUS.COMPLETED) completed += r.n;
    else if (r._id.status === STATUS.REJECTED) declined += r.n;
    else if (r._id.code === 'expired_accepted') noShows += r.n;
  }
  const judged = completed + declined + noShows;
  return {
    completed,
    declined,
    noShows,
    completionRate: judged ? Math.round((completed / judged) * 100) : null,
  };
}

/**
 * Share of completed jobs where the provider marked themselves arrived no
 * later than 15 minutes after the booked time. Jobs closed without an arrival
 * (the customer confirmed early) are not judged either way.
 */
async function onTimeRate(providerId) {
  const rows = await Booking.find({ provider: asId(providerId), status: STATUS.COMPLETED })
    .select('scheduledFor statusHistory')
    .sort({ scheduledFor: -1 })
    .limit(200)
    .lean();
  let judged = 0;
  let onTime = 0;
  for (const b of rows) {
    const arrived = (b.statusHistory || []).find((h) => h.status === STATUS.ARRIVED);
    if (!arrived || !b.scheduledFor) continue;
    judged += 1;
    if (new Date(arrived.changedAt).getTime() <= new Date(b.scheduledFor).getTime() + ON_TIME_GRACE_MS) {
      onTime += 1;
    }
  }
  return judged ? Math.round((onTime / judged) * 100) : null;
}

/** Share of this provider's customers who have come back for a second completed job. */
async function repeatCustomerRate(providerId) {
  const rows = await Booking.aggregate([
    { $match: { provider: asId(providerId), status: STATUS.COMPLETED } },
    { $group: { _id: '$customer', jobs: { $sum: 1 } } },
    { $group: { _id: null, customers: { $sum: 1 }, repeat: { $sum: { $cond: [{ $gte: ['$jobs', 2] }, 1, 0] } } } },
  ]);
  const r = rows[0];
  return r && r.customers ? Math.round((r.repeat / r.customers) * 100) : null;
}

module.exports = { outcomeStats, onTimeRate, repeatCustomerRate, ON_TIME_GRACE_MS };
