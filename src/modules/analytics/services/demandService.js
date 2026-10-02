/**
 * Demand — what happened (actuals) and what the forecast expects.
 *
 * Actuals are counted live from the source collections; forecasts come from
 * ml_demand_forecasts (ml/mm_ml/jobs/forecast_demand.py, nightly), with the
 * model's own backtest metrics from ml_model_registry so every chart can say
 * how much to trust it.
 */
const mongoose = require('mongoose');
const builders = require('./builders');

const VERTICALS = ['homeservice', 'healthcare', 'shopping'];

const toObjectId = (id) => (mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : id);

async function actuals(vertical, segment, since, until) {
  let rows;
  if (vertical === 'homeservice') {
    rows = await require('../../homeservice/models/Booking').aggregate(builders.homeserviceDemand(since, segment));
  } else if (vertical === 'healthcare') {
    rows = await require('../../healthcare/models/Appointment').aggregate(builders.healthcareDemand(since, segment, toObjectId));
  } else {
    rows = await require('../../shopping/models/Order').aggregate(builders.shoppingDemand(since, segment, toObjectId));
  }
  return builders.fillDays(rows, since, until);
}

/** The latest forecast version for a series, from today onwards. */
async function forecast(vertical, segment, fromDay, days) {
  const MlDemandForecast = require('../../ml/models/MlDemandForecast');
  const latest = await MlDemandForecast.findOne({ vertical, segment }).sort({ generatedAt: -1 }).select('version').lean();
  if (!latest) return { version: null, points: [] };
  const points = await MlDemandForecast.find({ vertical, segment, version: latest.version, date: { $gte: fromDay } })
    .sort({ date: 1 })
    .limit(days)
    .select('date yhat lo hi method segmentLabel')
    .lean();
  return {
    version: latest.version,
    method: points[0] ? points[0].method : null,
    label: points[0] ? points[0].segmentLabel : '',
    points: points.map((p) => ({ date: p.date, yhat: p.yhat, lo: p.lo, hi: p.hi })),
  };
}

async function modelInfo(version) {
  const MlModelRegistry = require('../../ml/models/MlModelRegistry');
  const row = version
    ? await MlModelRegistry.findOne({ task: 'demand_forecast', version }).lean()
    : await MlModelRegistry.findOne({ task: 'demand_forecast' }).sort({ createdAt: -1 }).lean();
  if (!row) return null;
  return {
    version: row.version,
    trainedAt: row.createdAt,
    source: row.trainedOn ? row.trainedOn.source : 'real',
    metrics: row.metrics || {},
    dataQuality: row.metrics && row.metrics.dataQuality ? row.metrics.dataQuality : null,
  };
}

/** Segments that have a forecast, for the admin picker. */
async function segments(vertical) {
  const MlDemandForecast = require('../../ml/models/MlDemandForecast');
  const rows = await MlDemandForecast.aggregate([
    { $match: { vertical } },
    { $sort: { generatedAt: -1 } },
    { $group: { _id: '$segment', label: { $first: '$segmentLabel' } } },
    { $sort: { _id: 1 } },
  ]);
  return rows.map((r) => ({ key: r._id, label: r.label || r._id }));
}

async function getDemand({ vertical, segment = 'all', historyDays = 28, forecastDays = 14, now = new Date() }) {
  if (!VERTICALS.includes(vertical)) throw new Error(`vertical must be one of ${VERTICALS.join(', ')}`);
  const since = new Date(now.getTime() - historyDays * 86400000);
  const today = new Date(now.getTime() + 5 * 3600000).toISOString().slice(0, 10);
  const [history, fc, segs] = await Promise.all([
    actuals(vertical, segment, since, now),
    forecast(vertical, segment, today, forecastDays),
    segments(vertical),
  ]);
  return {
    vertical,
    segment,
    segments: segs,
    history,
    forecast: fc.points,
    model: fc.version ? { ...(await modelInfo(fc.version)), method: fc.method } : null,
  };
}

/** Sum of the next `days` forecast points — for "expected demand" cards. */
function expectedTotal(points, days = 7) {
  const slice = points.slice(0, days);
  return {
    days: slice.length,
    total: Math.round(slice.reduce((s, p) => s + (p.yhat || 0), 0)),
    lo: Math.round(slice.reduce((s, p) => s + (p.lo ?? p.yhat ?? 0), 0)),
    hi: Math.round(slice.reduce((s, p) => s + (p.hi ?? p.yhat ?? 0), 0)),
  };
}

module.exports = { getDemand, expectedTotal, actuals, forecast, VERTICALS };
