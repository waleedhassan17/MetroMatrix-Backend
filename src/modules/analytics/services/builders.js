/**
 * Aggregation builders for the analytics service — pure, so every pipeline is
 * unit-tested without a database (same pattern as healthcare/doctorQueries).
 *
 * Days are Pakistan calendar days (UTC+05:00, no DST), the way every user of
 * the platform counts them.
 */
const PKT = '+05:00';
const QA_TAG = /\[QA-E2E/;

/** { $dateToString } of a date field as a Pakistan calendar day. */
const pktDay = (field) => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: PKT } });

/** Daily counts of documents created since `since`, optionally split by a segment expression. */
function dailyCounts({ match, since, segmentExpr = null }) {
  return [
    { $match: { ...match, createdAt: { $gte: since } } },
    {
      $group: {
        _id: { day: pktDay('$createdAt'), ...(segmentExpr ? { segment: segmentExpr } : {}) },
        n: { $sum: 1 },
      },
    },
    { $sort: { '_id.day': 1 } },
  ];
}

/** Home-service demand = booking requests per day (QA traffic excluded). */
function homeserviceDemand(since, segment) {
  const match = { description: { $not: QA_TAG } };
  if (segment && segment !== 'all') match.serviceCategory = segment;
  return dailyCounts({ match, since });
}

/** Shopping demand = orders placed per day; segment = brand id. */
function shoppingDemand(since, segment, toObjectId) {
  const match = {};
  if (segment && segment !== 'all') match.brandId = toObjectId(segment);
  return dailyCounts({ match, since });
}

/** Healthcare demand = appointments booked per day; segment = specialty id (via the doctor). */
function healthcareDemand(since, segment, toObjectId) {
  const pipeline = [{ $match: { createdAt: { $gte: since } } }];
  if (segment && segment !== 'all') {
    pipeline.push(
      { $lookup: { from: 'doctors', localField: 'doctorId', foreignField: '_id', as: 'd', pipeline: [{ $project: { specialtyId: 1 } }] } },
      { $match: { 'd.specialtyId': toObjectId(segment) } }
    );
  }
  pipeline.push({ $group: { _id: { day: pktDay('$createdAt') }, n: { $sum: 1 } } }, { $sort: { '_id.day': 1 } });
  return pipeline;
}

/** Every Pakistan day from `since` to `until`, so a day with no orders is a 0, not a gap. */
function fillDays(rows, since, until) {
  const counts = new Map(rows.map((r) => [r._id.day, r.n]));
  const out = [];
  const offset = 5 * 60 * 60 * 1000;
  const day = new Date(Date.UTC(...ymd(new Date(since.getTime() + offset))));
  const end = new Date(until.getTime() + offset);
  while (day <= end) {
    const key = day.toISOString().slice(0, 10);
    out.push({ date: key, actual: counts.get(key) || 0 });
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return out;
}
function ymd(d) {
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
}

/**
 * Home-service provider leaderboard over a window: volume, completion,
 * declines, provider cancellations, and earnings from paid bookings.
 */
function homeservicePerformance(since, limit) {
  return [
    { $match: { createdAt: { $gte: since }, description: { $not: QA_TAG } } },
    {
      $group: {
        _id: '$provider',
        requests: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
        declined: { $sum: { $cond: [{ $eq: ['$status', 'REJECTED'] }, 1, 0] } },
        providerCancelled: {
          $sum: { $cond: [{ $and: [{ $eq: ['$status', 'CANCELLED'] }, { $eq: ['$cancellation.by', 'provider'] }] }, 1, 0] },
        },
        earnings: {
          $sum: {
            $cond: [
              { $eq: ['$payment.status', 'paid'] },
              { $ifNull: ['$payment.requestedAmount', { $ifNull: ['$pricing.finalPrice', 0] }] },
              0,
            ],
          },
        },
      },
    },
    { $lookup: { from: 'providers', localField: '_id', foreignField: '_id', as: 'p', pipeline: [{ $project: { fullName: 1, providerSubType: 1, ratings: 1, hideFromSearch: 1 } }] } },
    { $unwind: '$p' },
    { $match: { 'p.hideFromSearch': { $ne: true } } },
    {
      $addFields: {
        // Laplace-smoothed so one job does not read as 100%.
        completionRate: { $divide: [{ $add: ['$completed', 1] }, { $add: ['$requests', 2] }] },
        declineRate: { $divide: ['$declined', { $max: ['$requests', 1] }] },
        rating: { $ifNull: ['$p.ratings.average', 0] },
        reviews: { $ifNull: ['$p.ratings.count', 0] },
      },
    },
    { $sort: { completed: -1, completionRate: -1, rating: -1 } },
    { $limit: limit },
  ];
}

function healthcarePerformance(since, limit) {
  return [
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: '$doctorId',
        appointments: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
        doctorCancelled: {
          $sum: { $cond: [{ $and: [{ $eq: ['$status', 'cancelled'] }, { $eq: ['$cancelledBy', 'doctor'] }] }, 1, 0] },
        },
      },
    },
    { $lookup: { from: 'doctors', localField: '_id', foreignField: '_id', as: 'd', pipeline: [{ $project: { providerId: 1, rating: 1, totalReviews: 1, specialtyId: 1 } }] } },
    { $unwind: '$d' },
    { $lookup: { from: 'providers', localField: 'd.providerId', foreignField: '_id', as: 'p', pipeline: [{ $project: { fullName: 1 } }] } },
    { $lookup: { from: 'specialties', localField: 'd.specialtyId', foreignField: '_id', as: 's', pipeline: [{ $project: { name: 1 } }] } },
    {
      $addFields: {
        completionRate: { $divide: [{ $add: ['$completed', 1] }, { $add: ['$appointments', 2] }] },
        rating: { $ifNull: ['$d.rating', 0] },
        reviews: { $ifNull: ['$d.totalReviews', 0] },
      },
    },
    { $sort: { completed: -1, completionRate: -1, rating: -1 } },
    { $limit: limit },
  ];
}

function shoppingPerformance(since, limit) {
  return [
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: '$brandId',
        orders: { $sum: 1 },
        delivered: { $sum: { $cond: [{ $eq: ['$orderStatus', 'delivered'] }, 1, 0] } },
        returned: { $sum: { $cond: [{ $in: ['$orderStatus', ['returned', 'refunded']] }, 1, 0] } },
        cancelled: { $sum: { $cond: [{ $eq: ['$orderStatus', 'cancelled'] }, 1, 0] } },
        gmv: { $sum: { $cond: [{ $eq: ['$orderStatus', 'delivered'] }, '$total', 0] } },
      },
    },
    { $lookup: { from: 'brands', localField: '_id', foreignField: '_id', as: 'b', pipeline: [{ $project: { name: 1, logo: 1 } }] } },
    { $unwind: '$b' },
    {
      $addFields: {
        returnRate: { $divide: ['$returned', { $max: ['$delivered', 1] }] },
        fulfilmentRate: { $divide: [{ $add: ['$delivered', 1] }, { $add: ['$orders', 2] }] },
      },
    },
    { $sort: { gmv: -1, orders: -1 } },
    { $limit: limit },
  ];
}

module.exports = {
  PKT,
  pktDay,
  dailyCounts,
  homeserviceDemand,
  shoppingDemand,
  healthcareDemand,
  fillDays,
  homeservicePerformance,
  healthcarePerformance,
  shoppingPerformance,
};
