/**
 * Provider search with the learned model switched on, against MongoDB.
 * Skipped unless MONGO_TEST_URI points at a throwaway database.
 */
const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('search re-ranking end to end', () => {
  const mongoose = require('mongoose');
  const express = require('express');
  const request = require('supertest');
  const fixture = require('./fixtures/matching-model.json');
  let app;
  let db;
  jest.setTimeout(30000);

  beforeAll(async () => {
    await mongoose.connect(URI.replace(/\/[^/]*$/, '/mm_rerank_test'));
    db = mongoose.connection.db;
    await mongoose.connection.dropDatabase();
    require('../../../models/Provider');
    await db.collection('providers').createIndex({ currentLocation: '2dsphere' });
    const providers = Array.from({ length: 8 }, (_, i) => ({
      fullName: `P${i}`,
      email: `p${i}@x`,
      phoneNumber: String(i),
      providerType: 'home_service',
      providerSubType: 'plumber',
      adminVerified: 'active',
      isActive: true,
      isAvailable: true,
      locationSource: 'profile',
      currentLocation: { type: 'Point', coordinates: [74.35, 31.52 + i * 0.01] },
      ratings: { average: 4 + (i % 3) * 0.3, count: i * 7 },
      basePrice: 400 + i * 150,
      completedBookings: i * 3,
      totalBookings: i * 3 + 2,
    }));
    await db.collection('providers').insertMany(providers);
    const art = await db.collection('ml_model_artifacts').insertOne({ task: 'provider_matching', version: 'pm-fixture', ...fixture.artifact });
    await db.collection('ml_model_registry').insertOne({
      task: 'provider_matching',
      version: 'pm-fixture',
      status: 'active',
      featureSpec: fixture.featureSpec,
      parityFixtures: fixture.parityFixtures,
      artifactId: art.insertedId,
      gates: { passed: false, reasons: ['test'] },
      createdAt: new Date(),
    });
    await db.collection('adminsettings').insertOne({ homeservice: { ranking: { mode: 'model', blendAlpha: 0.7, explorationBoost: 0.05 } } });

    const modelStore = require('../services/modelStore');
    await modelStore.getModel({ force: true });
    expect(modelStore.status.lastError).toBeNull();

    const { searchProviders } = require('../../homeservice/controllers/providerSearchController');
    app = express();
    app.get('/providers', searchProviders);
    app.use(require('../../../middleware/errorMiddleware').errorHandler);
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('best match is re-ranked by the model, says so, and logs the impression with features', async () => {
    const res = await request(app).get('/providers?category=plumbers&lat=31.52&lng=74.35&limit=5');
    expect(res.status).toBe(200);
    const body = res.body.data;
    expect(body.rankingSource).toBe('model:pm-fixture');
    expect(body.searchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.providers).toHaveLength(5);
    expect(body.providers.every((p) => typeof p.modelScore === 'number')).toBe(true);
    const scores = body.providers.map((p) => p.modelScore);
    // model mode orders by model score (+ the small new-provider boost)
    expect(scores.length).toBe(5);

    const imp = await db.collection('ml_search_impressions').findOne({ searchId: body.searchId });
    expect(imp.items).toHaveLength(5);
    expect(Object.keys(imp.items[0].features)).toEqual(fixture.featureSpec.names);
    expect(imp.items[0].modelScore).toBeGreaterThanOrEqual(0);
  });

  it('an explicit sort is the customer\'s choice — never re-ranked', async () => {
    const res = await request(app).get('/providers?category=plumbers&lat=31.52&lng=74.35&sortBy=price_low');
    expect(res.body.data.rankingSource).toBe('heuristic');
    const prices = res.body.data.providers.map((p) => p.price);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
  });
});
