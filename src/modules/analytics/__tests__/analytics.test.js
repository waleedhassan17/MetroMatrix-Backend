const builders = require('../services/builders');
const { expectedTotal } = require('../services/demandService');

describe('analytics builders', () => {
  it('fills every Pakistan day, so a quiet day is a 0 and not a gap', () => {
    const since = new Date('2026-09-27T19:00:00Z'); // 28 Sep 00:00 PKT
    const until = new Date('2026-09-30T10:00:00Z'); // 30 Sep 15:00 PKT
    const rows = [{ _id: { day: '2026-09-28' }, n: 3 }, { _id: { day: '2026-09-30' }, n: 1 }];
    expect(builders.fillDays(rows, since, until)).toEqual([
      { date: '2026-09-28', actual: 3 },
      { date: '2026-09-29', actual: 0 },
      { date: '2026-09-30', actual: 1 },
    ]);
  });

  it('counts days in Pakistan time, not UTC', () => {
    const [, group] = builders.dailyCounts({ match: {}, since: new Date() });
    expect(group.$group._id.day.$dateToString.timezone).toBe('+05:00');
  });

  it('home-service demand leaves QA traffic out', () => {
    const [match] = builders.homeserviceDemand(new Date(), 'plumbers');
    expect(match.$match.serviceCategory).toBe('plumbers');
    expect(String(match.$match.description.$not)).toMatch(/QA-E2E/);
  });

  it('expected total sums the next week with its band', () => {
    const pts = [1, 2, 3, 4, 5, 6, 7, 8].map((y) => ({ yhat: y, lo: y - 1, hi: y + 1 }));
    expect(expectedTotal(pts, 7)).toEqual({ days: 7, total: 28, lo: 21, hi: 35 });
  });
});

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('analytics against MongoDB', () => {
  const mongoose = require('mongoose');
  const NOW = new Date('2026-10-01T09:00:00Z');
  const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000);
  let db;

  beforeAll(async () => {
    await mongoose.connect(URI.replace(/\/[^/]*$/, '/mm_analytics_test'));
    db = mongoose.connection.db;
    require('../../../models/Provider');
    require('../../homeservice/models/Booking');
    require('../../shopping/models/Order');
    require('../../ml/models/MlDemandForecast');
    require('../../ml/models/MlModelRegistry');
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('demand: actuals per day plus the latest forecast and its metrics', async () => {
    const p1 = new mongoose.Types.ObjectId();
    await db.collection('hsbookings').insertMany([
      { provider: p1, serviceCategory: 'plumbers', status: 'COMPLETED', createdAt: daysAgo(1), description: '' },
      { provider: p1, serviceCategory: 'plumbers', status: 'PENDING', createdAt: daysAgo(1), description: '' },
      { provider: p1, serviceCategory: 'plumbers', status: 'PENDING', createdAt: daysAgo(1), description: '[QA-E2E run1] test' },
      { provider: p1, serviceCategory: 'electricians', status: 'PENDING', createdAt: daysAgo(2), description: '' },
    ]);
    await db.collection('ml_demand_forecasts').insertMany([
      { vertical: 'homeservice', segment: 'plumbers', date: '2026-10-01', yhat: 2.5, lo: 1, hi: 4, method: 'seasonal_naive', version: 'v1', generatedAt: daysAgo(1) },
      { vertical: 'homeservice', segment: 'plumbers', date: '2026-10-02', yhat: 3, lo: 1, hi: 5, method: 'seasonal_naive', version: 'v1', generatedAt: daysAgo(1) },
      { vertical: 'homeservice', segment: 'plumbers', date: '2026-10-01', yhat: 99, version: 'v0', generatedAt: daysAgo(5) },
    ]);
    await db.collection('ml_model_registry').insertOne({ task: 'demand_forecast', version: 'v1', status: 'active', metrics: { wape: 0.31, dataQuality: 'thin' }, trainedOn: { source: 'real' }, createdAt: daysAgo(1) });

    const { getDemand } = require('../services/demandService');
    const out = await getDemand({ vertical: 'homeservice', segment: 'plumbers', historyDays: 3, forecastDays: 7, now: NOW });
    const byDay = Object.fromEntries(out.history.map((h) => [h.date, h.actual]));
    expect(byDay['2026-09-30']).toBe(2); // QA booking excluded
    expect(out.forecast.map((f) => f.yhat)).toEqual([2.5, 3]); // latest version only
    expect(out.model).toMatchObject({ version: 'v1', metrics: { wape: 0.31 }, dataQuality: 'thin', method: 'seasonal_naive' });
    expect(out.segments.map((s) => s.key)).toEqual(['plumbers']);
  });

  it('performance: provider leaderboard with completion and earnings', async () => {
    const good = new mongoose.Types.ObjectId();
    const flaky = new mongoose.Types.ObjectId();
    await db.collection('providers').insertMany([
      { _id: good, fullName: 'Good', email: 'g@x', phoneNumber: '1', providerSubType: 'plumber', ratings: { average: 4.8, count: 10 } },
      { _id: flaky, fullName: 'Flaky', email: 'f@x', phoneNumber: '2', providerSubType: 'plumber', ratings: { average: 3.9, count: 4 } },
    ]);
    await db.collection('hsbookings').insertMany([
      ...Array.from({ length: 4 }, () => ({ provider: good, status: 'COMPLETED', createdAt: daysAgo(3), description: '', payment: { status: 'paid', requestedAmount: 1500 } })),
      { provider: flaky, status: 'REJECTED', createdAt: daysAgo(3), description: '' },
      { provider: flaky, status: 'CANCELLED', cancellation: { by: 'provider' }, createdAt: daysAgo(3), description: '' },
      { provider: flaky, status: 'COMPLETED', createdAt: daysAgo(3), description: '' },
    ]);
    const { getPerformance } = require('../services/performanceService');
    const rows = await getPerformance({ module: 'homeservice', days: 30, now: NOW });
    const good1 = rows.find((r) => r.name === 'Good');
    const flaky1 = rows.find((r) => r.name === 'Flaky');
    expect(rows[0].name).toBe('Good');
    expect(good1).toMatchObject({ completed: 4, earnings: 6000 });
    expect(flaky1).toMatchObject({ declined: 1, providerCancelled: 1 });
    expect(good1.completionRate).toBeGreaterThan(flaky1.completionRate);
  });

  it('shopping performance: GMV counts delivered orders only', async () => {
    const brand = new mongoose.Types.ObjectId();
    await db.collection('brands').insertOne({ _id: brand, name: 'Gul' });
    await db.collection('shoppingorders').insertMany([
      { odexId: 'O-1', brandId: brand, orderStatus: 'delivered', total: 3000, createdAt: daysAgo(2) },
      { odexId: 'O-2', brandId: brand, orderStatus: 'cancelled', total: 9000, createdAt: daysAgo(2) },
      { odexId: 'O-3', brandId: brand, orderStatus: 'refunded', total: 1000, createdAt: daysAgo(2) },
    ]);
    const { getPerformance } = require('../services/performanceService');
    const [row] = await getPerformance({ module: 'shopping', days: 30, now: NOW });
    expect(row).toMatchObject({ name: 'Gul', orders: 3, delivered: 1, gmv: 3000, returned: 1, cancelled: 1 });
  });

  it('realtime overview counts live state, and a missing realtime service leaves only its tiles empty', async () => {
    delete process.env.REALTIME_URL;
    const live = new mongoose.Types.ObjectId();
    await db.collection('providers').insertMany([
      { fullName: 'OnNow', email: 'on@x', phoneNumber: '9', providerType: 'home_service', adminVerified: 'active', isActive: true, isOnline: true, lastSeen: new Date(NOW.getTime() - 2 * 60000), availability: {} },
      { fullName: 'Stale', email: 'st@x', phoneNumber: '8', providerType: 'home_service', adminVerified: 'active', isActive: true, isOnline: true, lastSeen: daysAgo(1), availability: {} },
    ]);
    await db.collection('hsbookings').insertMany([
      { provider: live, status: 'EN_ROUTE', createdAt: NOW, description: '' },
      { provider: live, status: 'IN_PROGRESS', createdAt: NOW, description: '' },
    ]);
    const { databaseCounts } = require('../services/realtimeService');
    const out = await databaseCounts(NOW); // Wednesday 14:00 PKT — inside default hours
    expect(out.homeservice.providersAvailableNow).toBe(1);
    expect(out.homeservice.onTheWayNow).toBe(1);
    expect(out.homeservice.inProgressNow).toBe(1);
    const { realtimeServiceStats } = require('../services/realtimeService');
    expect(await realtimeServiceStats()).toBeNull();
  });
});
