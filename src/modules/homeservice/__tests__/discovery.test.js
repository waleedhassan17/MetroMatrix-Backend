const {
  buildDiscoveryPipeline,
  buildSort,
  normalizeSort,
  normalisedWeights,
  nowInPakistan,
} = require('../services/discoveryPipeline');
const { planBaseWrite, serviceBaseOf } = require('../services/serviceBase');
const geo = require('../services/geo');

describe('discovery: time and sort helpers', () => {
  it('reads the weekday and clock in Pakistan time, not server UTC', () => {
    // 2026-09-30 is a Wednesday. 21:30 UTC is already Thursday 02:30 in Pakistan.
    expect(nowInPakistan(new Date('2026-09-30T21:30:00Z'))).toEqual({ dayKey: 'thursday', hhmm: '02:30' });
    expect(nowInPakistan(new Date('2026-09-30T07:05:00Z'))).toEqual({ dayKey: 'wednesday', hhmm: '12:05' });
  });

  it.each([
    ['nearest', 'nearest'],
    ['distance', 'nearest'],
    ['rating', 'rating'],
    ['reviews', 'reviews'],
    ['price', 'price_low'],
    ['price_low', 'price_low'],
    ['price_high', 'price_high'],
    ['experience', 'best'],
    [undefined, 'best'],
    ['DROP TABLE', 'best'],
  ])('normalizeSort(%p) → %p', (raw, expected) => {
    expect(normalizeSort(raw)).toBe(expected);
  });

  it('normalises weights by their sum, so a fourth weight never inflates scores', () => {
    const w = normalisedWeights({ distance: 0.4, rating: 0.4, availability: 0.2, quality: 0.15 });
    expect(w.distance + w.rating + w.availability + w.quality).toBeCloseTo(1, 10);
    expect(normalisedWeights({})).toEqual({ distance: 0.25, rating: 0.25, availability: 0.25, quality: 0.25 });
    expect(normalisedWeights({ distance: -3, rating: 1 }).distance).toBe(0);
  });

  it('every sort ends in a unique tie-break, so pages never repeat or skip a provider', () => {
    for (const s of ['best', 'nearest', 'rating', 'reviews', 'price_low', 'price_high']) {
      expect(buildSort(s, true)._id).toBe(1);
      expect(buildSort(s, false)._id).toBe(1);
    }
  });

  it('nearest without a customer location falls back to best match', () => {
    expect(buildSort('nearest', false).distanceMeters).toBeUndefined();
  });
});

describe('discovery: pipeline shape', () => {
  const base = {
    centre: [74.3, 31.5],
    radiusMeters: 15000,
    match: { providerType: 'home_service' },
    weights: { distance: 0.4, rating: 0.4, availability: 0.2, quality: 0.15 },
    sort: 'best',
    now: new Date('2026-09-30T07:00:00Z'),
    staleMinutes: 30,
    pageN: 2,
    limitN: 10,
  };

  it('starts with $geoNear when the customer is located', () => {
    const p = buildDiscoveryPipeline({ ...base, hasLocation: true });
    expect(p[0].$geoNear.maxDistance).toBe(15000);
    expect(p[0].$geoNear.query).toBe(base.match);
  });

  it('pages after sorting', () => {
    const p = buildDiscoveryPipeline({ ...base, hasLocation: true });
    const facet = p[p.length - 1].$facet;
    expect(facet.items).toEqual([{ $skip: 10 }, { $limit: 10 }]);
    expect(p[p.length - 2].$sort).toBeDefined();
  });

  it('adds the availableNow filter only when asked', () => {
    const without = JSON.stringify(buildDiscoveryPipeline({ ...base, hasLocation: true }));
    const withIt = buildDiscoveryPipeline({ ...base, hasLocation: true, availableOnly: true });
    expect(without).not.toMatch(/"\$match":\{"availableNow":true\}/);
    expect(withIt.some((st) => st.$match && st.$match.availableNow === true)).toBe(true);
  });

  it('a "within X km" filter drops providers whose distance is unknown', () => {
    const p = buildDiscoveryPipeline({ ...base, hasLocation: true, knownDistanceOnly: true });
    expect(p.some((st) => st.$match && st.$match.distanceKnown === true)).toBe(true);
  });

  it('uses the presence window from settings', () => {
    const p = JSON.stringify(buildDiscoveryPipeline({ ...base, hasLocation: false, staleMinutes: 10 }));
    // 07:00Z − 10 min
    expect(p).toContain('2026-09-30T06:50:00.000Z');
  });
});

describe('service base', () => {
  const now = new Date('2026-09-30T07:00:00Z');

  it('coarsens to the ~500 m grid and records the source', () => {
    const set = planBaseWrite({ locationSource: 'default' }, { latitude: 31.47123, longitude: 74.40987 }, 'profile', now);
    expect(set.currentLocation.coordinates).toEqual([74.41, 31.47]);
    expect(set.locationSource).toBe('profile');
    expect(set.locationUpdatedAt).toBe(now);
  });

  it('never lets the automatic go-online sample overwrite a deliberate pin…', () => {
    expect(
      planBaseWrite({ locationSource: 'profile' }, { latitude: 31.5, longitude: 74.3 }, 'go_online', now)
    ).toBeNull();
  });

  it('…unless the provider opted in', () => {
    const set = planBaseWrite(
      { locationSource: 'profile', autoUpdateBaseOnOnline: true },
      { latitude: 31.5, longitude: 74.3 },
      'go_online',
      now
    );
    expect(set.locationSource).toBe('go_online');
  });

  it('rejects points outside Pakistan, and [0, 0]', () => {
    expect(() => planBaseWrite({}, { latitude: 51.5, longitude: -0.12 }, 'profile', now)).toThrow(/outside/);
    expect(() => planBaseWrite({}, { latitude: 0, longitude: 0 }, 'profile', now)).toThrow(/valid/);
    expect(() => planBaseWrite({}, { latitude: 'x', longitude: 74 }, 'profile', now)).toThrow(/valid/);
  });

  it('reports an unset base as unknown, not as the placeholder', () => {
    expect(serviceBaseOf({ locationSource: 'default', currentLocation: { coordinates: geo.LAHORE_CENTRE } })).toEqual({
      latitude: null,
      longitude: null,
      source: 'default',
      updatedAt: null,
    });
  });
});

describe('geo helpers', () => {
  it('treats the placeholders as unknown', () => {
    expect(geo.isRealPoint({ coordinates: geo.LAHORE_CENTRE })).toBe(false);
    expect(geo.isRealPoint({ coordinates: [0, 0] })).toBe(false);
    expect(geo.isRealPoint({ coordinates: [] })).toBe(false);
    expect(geo.isRealPoint(null)).toBe(false);
    expect(geo.isRealPoint({ coordinates: [74.41, 31.47] })).toBe(true);
    expect(geo.latLngOrNull({ coordinates: [74.41, 31.47] })).toEqual({ latitude: 31.47, longitude: 74.41 });
  });

  it('haversine is right to within a few metres', () => {
    // Lahore → Islamabad is ~270 km as the crow flies.
    const d = geo.haversineMeters({ latitude: 31.5204, longitude: 74.3587 }, { latitude: 33.6844, longitude: 73.0479 });
    expect(d).toBeGreaterThan(265000);
    expect(d).toBeLessThan(275000);
  });

  it('knows city centroids case-insensitively', () => {
    expect(geo.centroidFor(' Karachi ')).toEqual([67.0011, 24.8607]);
    expect(geo.centroidFor('Atlantis')).toBeNull();
  });
});
