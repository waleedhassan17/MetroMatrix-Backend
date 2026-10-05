/**
 * Leaderboards: who serves customers well, per vertical, over a window. Every
 * row carries providerId (null for a brand the platform runs itself) so the
 * admin app can open that provider.
 */
const builders = require('./builders');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function getPerformance({ module, days = 90, limit = 20, now = new Date() }) {
  const since = new Date(now.getTime() - days * 86400000);
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  if (module === 'homeservice') {
    const rows = await require('../../homeservice/models/Booking').aggregate(builders.homeservicePerformance(since, lim));
    return rows.map((r) => ({
      id: String(r._id),
      providerId: String(r._id),
      name: r.p.fullName,
      category: r.p.providerSubType,
      requests: r.requests,
      completed: r.completed,
      declined: r.declined,
      providerCancelled: r.providerCancelled,
      completionRate: round2(r.completionRate),
      declineRate: round2(r.declineRate),
      rating: round2(r.rating),
      reviews: r.reviews,
      earnings: Math.round(r.earnings || 0),
    }));
  }
  if (module === 'healthcare') {
    const rows = await require('../../healthcare/models/Appointment').aggregate(builders.healthcarePerformance(since, lim));
    return rows.map((r) => ({
      id: String(r._id),
      providerId: r.d.providerId ? String(r.d.providerId) : null,
      name: (r.p[0] && r.p[0].fullName) || 'Doctor',
      specialty: (r.s[0] && r.s[0].name) || '',
      appointments: r.appointments,
      completed: r.completed,
      cancelled: r.cancelled,
      doctorCancelled: r.doctorCancelled,
      completionRate: round2(r.completionRate),
      rating: round2(r.rating),
      reviews: r.reviews,
    }));
  }
  if (module === 'shopping') {
    const rows = await require('../../shopping/models/Order').aggregate(builders.shoppingPerformance(since, lim));
    return rows.map((r) => ({
      id: String(r._id),
      providerId: r.b.owner ? String(r.b.owner) : null,
      name: r.b.name,
      orders: r.orders,
      delivered: r.delivered,
      returned: r.returned,
      cancelled: r.cancelled,
      gmv: Math.round(r.gmv || 0),
      returnRate: round2(r.returnRate),
      fulfilmentRate: round2(r.fulfilmentRate),
    }));
  }
  throw new Error("module must be 'homeservice', 'healthcare' or 'shopping'");
}

module.exports = { getPerformance };
