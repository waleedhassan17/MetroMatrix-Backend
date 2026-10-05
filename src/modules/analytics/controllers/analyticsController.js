const asyncHandler = require('express-async-handler');
const { getRealtimeOverview } = require('../services/realtimeService');
const { getDemand, expectedTotal, VERTICALS } = require('../services/demandService');
const { getPerformance } = require('../services/performanceService');

const ok = (res, data) => res.json({ success: true, data });
const bad = (res, message) => {
  res.status(400);
  throw new Error(message);
};

// GET /api/admin/platform/realtime
const realtime = asyncHandler(async (req, res) => ok(res, await getRealtimeOverview()));

// GET /api/admin/platform/demand?vertical=homeservice&segment=all&days=28
const demand = asyncHandler(async (req, res) => {
  const vertical = String(req.query.vertical || 'homeservice');
  if (!VERTICALS.includes(vertical)) bad(res, `vertical must be one of ${VERTICALS.join(', ')}`);
  const segment = String(req.query.segment || 'all').slice(0, 64);
  const historyDays = Math.min(Math.max(Number(req.query.days) || 28, 7), 120);
  ok(res, await getDemand({ vertical, segment, historyDays }));
});

// GET /api/admin/platform/performance?module=homeservice&days=90&limit=20
const performance = asyncHandler(async (req, res) => {
  const module = String(req.query.module || 'homeservice');
  if (!VERTICALS.includes(module)) bad(res, `module must be one of ${VERTICALS.join(', ')}`);
  const days = Math.min(Math.max(Number(req.query.days) || 90, 7), 365);
  ok(res, { module, days, rows: await getPerformance({ module, days, limit: req.query.limit }) });
});

/** The signed-in provider's own demand series: trade, specialty or brand. */
async function seriesFor(req) {
  if (!req.isProvider) return null;
  const p = req.user;
  if (p.providerType === 'home_service') {
    const { SUBTYPE_TO_CATEGORY } = require('../../homeservice/services/serializers');
    const cat = SUBTYPE_TO_CATEGORY[p.providerSubType];
    return cat ? { vertical: 'homeservice', segment: cat, label: cat.replace('-', ' ') } : null;
  }
  if (p.providerType === 'doctor') {
    const Doctor = require('../../healthcare/models/Doctor');
    const d = await Doctor.findOne({ providerId: p._id }).select('specialtyId').populate('specialtyId', 'name').lean();
    if (!d || !d.specialtyId) return null;
    return { vertical: 'healthcare', segment: String(d.specialtyId._id || d.specialtyId), label: d.specialtyId.name || 'your specialty' };
  }
  if (p.providerType === 'vendor') {
    const Brand = require('../../shopping/models/Brand');
    const b = await Brand.findOne({ owner: p._id, isDeleted: { $ne: true } }).select('name').lean();
    return b ? { vertical: 'shopping', segment: String(b._id), label: b.name } : null;
  }
  return null;
}

// GET /api/insights/demand/mine — "expected demand next 7 days" for dashboards
const myDemand = asyncHandler(async (req, res) => {
  const series = await seriesFor(req);
  if (!series) return ok(res, null);
  const d = await getDemand({ ...series, historyDays: 14, forecastDays: 7 });
  const lastWeek = d.history.slice(-7).reduce((s, p) => s + p.actual, 0);
  ok(res, {
    vertical: series.vertical,
    segment: series.segment,
    label: series.label,
    next7: d.forecast.length ? expectedTotal(d.forecast, 7) : null,
    lastWeek,
    daily: d.forecast.slice(0, 7),
    model: d.model ? { method: d.model.method, dataQuality: d.model.dataQuality, source: d.model.source } : null,
  });
});

module.exports = { realtime, demand, performance, myDemand, seriesFor };
