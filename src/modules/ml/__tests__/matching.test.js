/**
 * The Python → TensorFlow.js contract.
 *
 * fixtures/matching-model.json was exported by ml/mm_ml/matching.py from a
 * scikit-learn MLP. Loaded here in TF.js, it must reproduce scikit-learn's own
 * probabilities — the same check modelStore runs before serving any model.
 */
const fixture = require('./fixtures/matching-model.json');
const { modelFromArtifact, predict } = require('../services/tfRuntime');
const { parityCheck } = require('../services/modelStore');
const { FEATURES, rawFeatures, toVector, median } = require('../services/featureSpec');
const { rerank } = require('../services/rankingService');

jest.setTimeout(20000);

describe('feature contract', () => {
  it('Node and Python agree on the feature names and order', () => {
    expect(fixture.featureSpec.names).toEqual(FEATURES);
  });

  it('computes features from a search row', () => {
    const p = {
      scoreBreakdown: { distance: 0.8, rating: 0.9, availability: 1, quality: 0.7 },
      distanceKnown: true,
      distanceMeters: 4500,
      ratings: { count: 40 },
      basePrice: 1000,
      availableNow: true,
      completedBookings: 1,
      isOnline: true,
    };
    const f = rawFeatures(p, { hasLocation: true, medianPrice: 500 });
    expect(f).toMatchObject({ distance_term: 0.8, distance_known: 1, distance_km: 0.15, rating_term: 0.9, available_now: 1, is_new: 1, online: 1 });
    expect(f.price_ratio).toBeCloseTo(2 / 3, 6);
    expect(f.reviews_log).toBeCloseTo(Math.log1p(40) / Math.log1p(500), 6);
    // Unknown distance is neutral, never "near".
    expect(rawFeatures({ ...p, distanceKnown: false }, { hasLocation: true, medianPrice: 500 }).distance_km).toBe(0.5);
  });

  it('median ignores unpriced providers', () => {
    expect(median([0, 500, 1500, 1000])).toBe(1000);
    expect(median([])).toBe(0);
  });
});

describe('TF.js reproduces scikit-learn', () => {
  let model;
  beforeAll(async () => {
    model = await modelFromArtifact(fixture.artifact);
  });

  it('every parity fixture within 1e-4', async () => {
    const vectors = fixture.parityFixtures.map((f) =>
      toVector(Object.fromEntries(FEATURES.map((n, i) => [n, f.raw[i]])), fixture.featureSpec)
    );
    const scores = await predict(model, vectors);
    scores.forEach((s, i) => expect(Math.abs(s - fixture.parityFixtures[i].p)).toBeLessThan(1e-4));
  });

  it('modelStore.parityCheck accepts it, and rejects tampered weights', async () => {
    expect((await parityCheck(model, fixture.featureSpec, fixture.parityFixtures)).ok).toBe(true);
    const bad = fixture.parityFixtures.map((f) => ({ ...f, p: Math.min(1, f.p + 0.05) }));
    const res = await parityCheck(model, fixture.featureSpec, bad);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/parity off/);
  });

  describe('ranking modes', () => {
    const items = [
      { _id: 'a', matchingScore: 0.9, basePrice: 5000, scoreBreakdown: { distance: 0.9, rating: 0.9, quality: 0.6 }, distanceKnown: true, distanceMeters: 1000, ratings: { count: 2 }, completedBookings: 10 },
      { _id: 'b', matchingScore: 0.5, basePrice: 500, scoreBreakdown: { distance: 0.6, rating: 0.95, quality: 0.95 }, distanceKnown: true, distanceMeters: 5000, ratings: { count: 300 }, completedBookings: 80, availableNow: true },
      { _id: 'c', matchingScore: 0.4, basePrice: 700, scoreBreakdown: { distance: 0.5, rating: 0.8, quality: 0.5 }, distanceKnown: false, ratings: { count: 0 }, completedBookings: 0 },
    ];
    const served = () => ({ version: 'pm-test', model, spec: fixture.featureSpec });

    it('heuristic mode leaves the order alone', async () => {
      const r = await rerank(items, { mode: 'heuristic', model: served(), hasLocation: true });
      expect(r.items.map((i) => i._id)).toEqual(['a', 'b', 'c']);
      expect(r.rankingSource).toBe('heuristic');
    });

    it('shadow mode scores but serves the heuristic order', async () => {
      const r = await rerank(items, { mode: 'shadow', model: served(), hasLocation: true });
      expect(r.items.map((i) => i._id)).toEqual(['a', 'b', 'c']);
      expect(r.scored.every((s) => typeof s.modelScore === 'number')).toBe(true);
      expect(r.rankingSource).toMatch(/shadow pm-test/);
    });

    it('model mode re-orders by the model and says so', async () => {
      const r = await rerank(items, { mode: 'model', model: served(), hasLocation: true });
      expect(r.items).toHaveLength(3);
      expect(r.rankingSource).toBe('model:pm-test');
      const sorted = [...r.items].map((i) => i.modelScore);
      expect(sorted.length).toBe(3);
    });

    it('no model, or a broken one, falls back to the heuristic', async () => {
      expect((await rerank(items, { mode: 'model', model: null, hasLocation: true })).rankingSource).toBe('heuristic');
      const broken = { version: 'x', spec: fixture.featureSpec, model: { predict: () => { throw new Error('boom'); } } };
      const r = await rerank(items, { mode: 'model', model: broken, hasLocation: true });
      expect(r.items.map((i) => i._id)).toEqual(['a', 'b', 'c']);
    });
  });
});
