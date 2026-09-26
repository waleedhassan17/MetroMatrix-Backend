/**
 * Recompute home-service providers' public counters from the records behind
 * them.
 *
 * `ratings` (average, count, per-star breakdown), `completedBookings` and
 * `totalBookings` are denormalised onto the Provider for cheap list rendering.
 * The seed used to write them directly as made-up numbers, so a profile could
 * read "4.9 ★ (132 reviews)" above an empty review list. This brings every
 * counter back in line with the reviews and bookings that actually exist.
 * Idempotent — safe to run any number of times.
 */
const Provider = require('../../../models/Provider');
const Booking = require('../models/Booking');
const ProviderReview = require('../models/ProviderReview');
const { STATUS } = require('./statusMap');

const EMPTY_BREAKDOWN = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

/**
 * @param {object} [filter] which providers (default: every home-service provider)
 * @param {object} [opts] { dryRun } — compute and report without writing
 * @returns {Promise<Array<{id, name, before, after}>>} one row per provider that changed
 */
async function recomputeProviderCounters(filter = { providerType: 'home_service' }, opts = {}) {
  const providers = await Provider.find(filter)
    .select('_id fullName ratings completedBookings totalBookings')
    .lean();
  if (!providers.length) return [];
  const ids = providers.map((p) => p._id);

  const [reviewRows, bookingRows] = await Promise.all([
    ProviderReview.aggregate([
      { $match: { provider: { $in: ids } } },
      { $group: { _id: { provider: '$provider', rating: '$rating' }, n: { $sum: 1 } } },
    ]),
    Booking.aggregate([
      { $match: { provider: { $in: ids } } },
      {
        $group: {
          _id: '$provider',
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', STATUS.COMPLETED] }, 1, 0] } },
        },
      },
    ]),
  ]);

  const reviewsBy = new Map();
  for (const r of reviewRows) {
    const key = String(r._id.provider);
    const entry = reviewsBy.get(key) || { ...EMPTY_BREAKDOWN };
    const star = Math.min(5, Math.max(1, Math.round(r._id.rating)));
    entry[star] += r.n;
    reviewsBy.set(key, entry);
  }
  const bookingsBy = new Map(bookingRows.map((b) => [String(b._id), b]));

  const changed = [];
  for (const p of providers) {
    const breakdown = reviewsBy.get(String(p._id)) || { ...EMPTY_BREAKDOWN };
    const count = Object.values(breakdown).reduce((a, b) => a + b, 0);
    const sum = Object.entries(breakdown).reduce((a, [star, n]) => a + Number(star) * n, 0);
    const average = count ? Math.round((sum / count) * 100) / 100 : 0;
    const b = bookingsBy.get(String(p._id)) || { total: 0, completed: 0 };

    const before = {
      average: (p.ratings && p.ratings.average) || 0,
      count: (p.ratings && p.ratings.count) || 0,
      completed: p.completedBookings || 0,
      total: p.totalBookings || 0,
    };
    const after = { average, count, completed: b.completed, total: b.total };
    const same =
      before.average === after.average &&
      before.count === after.count &&
      before.completed === after.completed &&
      before.total === after.total;
    if (same) continue;

    changed.push({ id: String(p._id), name: p.fullName, before, after });
    if (!opts.dryRun) {
      await Provider.updateOne(
        { _id: p._id },
        {
          $set: {
            'ratings.average': average,
            'ratings.count': count,
            'ratings.breakdown': breakdown,
            completedBookings: b.completed,
            totalBookings: b.total,
          },
        }
      );
    }
  }
  return changed;
}

module.exports = { recomputeProviderCounters };
