/**
 * The discovery aggregation, run for real against MongoDB.
 *
 * Skipped unless MONGO_TEST_URI points at a THROWAWAY database (never the
 * shared Atlas cluster) — e.g. `docker run --rm -p 27099:27017 mongo:7` and
 * MONGO_TEST_URI=mongodb://127.0.0.1:27099/mm_discovery_test.
 */
const mongoose = require('mongoose');
const { buildDiscoveryPipeline } = require('../services/discoveryPipeline');
const { searchableProviderFilter } = require('../services/providerVisibility');

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

// Wednesday 12:00 in Pakistan.
const NOW = new Date('2026-09-30T07:00:00Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000);
const CUSTOMER = [74.35, 31.52]; // [lng, lat]
const WEIGHTS = { distance: 0.4, rating: 0.4, availability: 0.2, quality: 0.15 };
const WED_9_TO_5 = { wednesday: { start: '09:00', end: '17:00', isAvailable: true } };

let seq = 0;
function provider(overrides) {
  seq += 1;
  return {
    _id: new mongoose.Types.ObjectId(),
    fullName: `P${seq}`,
    providerType: 'home_service',
    providerSubType: 'plumber',
    adminVerified: 'active',
    isActive: true,
    isAvailable: true,
    isOnline: false,
    serviceRadius: 15,
    basePrice: 500,
    ratings: { average: 4.5, count: 20 },
    completedBookings: 10,
    totalBookings: 12,
    locationSource: 'profile',
    currentLocation: { type: 'Point', coordinates: CUSTOMER },
    availability: WED_9_TO_5,
    ...overrides,
  };
}
// ~1 km of latitude ≈ 0.009°
const north = (km) => ({ type: 'Point', coordinates: [CUSTOMER[0], CUSTOMER[1] + km * 0.009] });

d('discovery pipeline against MongoDB', () => {
  let col;

  beforeAll(async () => {
    await mongoose.connect(URI);
    col = mongoose.connection.collection('providers');
    await col.deleteMany({});
    await col.createIndex({ currentLocation: '2dsphere' });
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(() => col.deleteMany({}));

  async function run(opts) {
    const [res] = await col
      .aggregate(
        buildDiscoveryPipeline({
          centre: CUSTOMER,
          hasLocation: true,
          radiusMeters: 15000,
          match: searchableProviderFilter('plumber'),
          weights: WEIGHTS,
          sort: 'best',
          now: NOW,
          staleMinutes: 30,
          pageN: 1,
          limitN: 50,
          ...opts,
        })
      )
      .toArray();
    return { items: res.items, total: res.total[0] ? res.total[0].count : 0 };
  }

  it('ranks the nearer of two otherwise-equal providers first', async () => {
    await col.insertMany([
      provider({ fullName: 'Far', currentLocation: north(12) }),
      provider({ fullName: 'Near', currentLocation: north(2) }),
    ]);
    const { items } = await run({});
    expect(items.map((p) => p.fullName)).toEqual(['Near', 'Far']);
    expect(items[0].scoreBreakdown.distance).toBeGreaterThan(items[1].scoreBreakdown.distance);
  });

  it('available now = online, seen recently, inside today\'s hours', async () => {
    await col.insertMany([
      provider({ fullName: 'Fresh', isOnline: true, lastSeen: minutesAgo(5) }),
      provider({ fullName: 'Stale', isOnline: true, lastSeen: minutesAgo(120) }),
      provider({ fullName: 'Offline', isOnline: false, lastSeen: minutesAgo(1) }),
      provider({
        fullName: 'AfterHours',
        isOnline: true,
        lastSeen: minutesAgo(1),
        availability: { wednesday: { start: '06:00', end: '11:00', isAvailable: true } },
      }),
      provider({
        fullName: 'DayOff',
        isOnline: true,
        lastSeen: minutesAgo(1),
        availability: { wednesday: { start: '09:00', end: '17:00', isAvailable: false } },
      }),
      // Never set hours: the 09:00–20:00 default applies.
      provider({ fullName: 'DefaultHours', isOnline: true, lastSeen: minutesAgo(1), availability: {} }),
      provider({ fullName: 'Paused', isOnline: true, lastSeen: minutesAgo(1), isAvailable: false }),
    ]);
    const { items } = await run({});
    const now = Object.fromEntries(items.map((p) => [p.fullName, p.availableNow]));
    expect(now).toEqual({
      Fresh: true,
      Stale: false,
      Offline: false,
      AfterHours: false,
      DayOff: false,
      DefaultHours: true,
      Paused: false,
    });
    const onlyNow = await run({ availableOnly: true });
    expect(onlyNow.items.map((p) => p.fullName).sort()).toEqual(['DefaultHours', 'Fresh']);
  });

  it('a Bayesian rating keeps one 5★ review from outranking two hundred 4.8★', async () => {
    await col.insertMany([
      provider({ fullName: 'OneReview', ratings: { average: 5, count: 1 } }),
      provider({ fullName: 'Proven', ratings: { average: 4.8, count: 200 } }),
    ]);
    const { items } = await run({ sort: 'rating' });
    expect(items[0].fullName).toBe('Proven');
  });

  it('an unknown base is neither capped by service radius nor shown as near', async () => {
    await col.insertMany([
      // Placeholder point, no source: legacy data before the field existed.
      { ...provider({ fullName: 'Legacy' }), locationSource: undefined, currentLocation: { type: 'Point', coordinates: [74.3587, 31.5204] } },
      provider({ fullName: 'Pinned', currentLocation: north(3) }),
    ]);
    const { items } = await run({ sort: 'nearest' });
    expect(items.map((p) => p.fullName)).toEqual(['Pinned', 'Legacy']);
    const legacy = items.find((p) => p.fullName === 'Legacy');
    expect(legacy.distanceKnown).toBe(false);
    expect(legacy.scoreBreakdown.distance).toBe(0.5);
    const within = await run({ knownDistanceOnly: true });
    expect(within.items.map((p) => p.fullName)).toEqual(['Pinned']);
  });

  it('a seeded base written before locationSource existed still counts as known', async () => {
    await col.insertOne({ ...provider({ fullName: 'Seeded', currentLocation: north(1) }), locationSource: undefined });
    const { items } = await run({});
    expect(items[0].distanceKnown).toBe(true);
  });

  it('enforces each provider\'s own service radius', async () => {
    await col.insertMany([
      provider({ fullName: 'ShortReach', serviceRadius: 5, currentLocation: north(8) }),
      provider({ fullName: 'LongReach', serviceRadius: 20, currentLocation: north(8) }),
    ]);
    const { items } = await run({});
    expect(items.map((p) => p.fullName)).toEqual(['LongReach']);
  });

  it('without a customer location it searches every city', async () => {
    await col.insertMany([
      provider({ fullName: 'Lahore' }),
      provider({ fullName: 'Karachi', currentLocation: { type: 'Point', coordinates: [67.0, 24.86] } }),
    ]);
    const { items } = await run({ hasLocation: false, centre: null });
    expect(items.map((p) => p.fullName).sort()).toEqual(['Karachi', 'Lahore']);
    for (const p of items) expect(p.scoreBreakdown.distance).toBe(0.5);
  });

  it('scores stay within [0, 1] and quality prefers a reliable record', async () => {
    await col.insertMany([
      provider({ fullName: 'Reliable', completedBookings: 40, totalBookings: 42 }),
      provider({ fullName: 'Flaky', completedBookings: 4, totalBookings: 40 }),
      // Stale counter: completed exceeds total — must not push quality past 1.
      provider({ fullName: 'StaleCounter', completedBookings: 9, totalBookings: 3 }),
    ]);
    const { items } = await run({});
    for (const p of items) {
      expect(p.matchingScore).toBeGreaterThanOrEqual(0);
      expect(p.matchingScore).toBeLessThanOrEqual(1);
      expect(p.quality).toBeLessThanOrEqual(1);
    }
    const q = Object.fromEntries(items.map((p) => [p.fullName, p.quality]));
    expect(q.Reliable).toBeGreaterThan(q.Flaky);
  });

  it('pages without repeats under ties', async () => {
    await col.insertMany(Array.from({ length: 7 }, () => provider({})));
    const a = await run({ pageN: 1, limitN: 3 });
    const b = await run({ pageN: 2, limitN: 3 });
    const c = await run({ pageN: 3, limitN: 3 });
    const ids = [...a.items, ...b.items, ...c.items].map((p) => String(p._id));
    expect(new Set(ids).size).toBe(7);
    expect(a.total).toBe(7);
  });
});
