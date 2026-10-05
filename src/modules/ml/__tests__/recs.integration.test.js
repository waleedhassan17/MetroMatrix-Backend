/**
 * Recommendation serving against MongoDB: what the nightly job wrote, filtered
 * by what customers may see now, with honest fallbacks. Skipped unless
 * MONGO_TEST_URI points at a throwaway database.
 */
const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('recommendations (MongoDB)', () => {
  const mongoose = require('mongoose');
  const { ObjectId } = mongoose.Types;
  let db;
  let recs;
  const id = {};
  jest.setTimeout(30000);

  beforeAll(async () => {
    delete process.env.GEMINI_API_KEY;
    await mongoose.connect(URI.replace(/\/[^/]*$/, '/mm_recs_test'));
    db = mongoose.connection.db;
    await mongoose.connection.dropDatabase();
    recs = require('../services/recsService');

    // ── shopping ──
    const Product = require('../../shopping/models/Product');
    const Order = require('../../shopping/models/Order');
    id.brand = (await db.collection('brands').insertOne({ odexId: 'B1', name: 'Live', slug: 'live', status: 'active', isDeleted: false })).insertedId;
    id.deadBrand = (await db.collection('brands').insertOne({ odexId: 'B2', name: 'Gone', slug: 'gone', status: 'suspended', isDeleted: false })).insertedId;
    id.catA = new ObjectId();
    id.catB = new ObjectId();
    const mk = (name, o = {}) => ({ name, brandId: id.brand, categoryId: id.catA, basePrice: 1000, isActive: true, inStock: true, rating: 4, ...o });
    const ps = await Product.create([
      mk('Visible A'),
      mk('Visible B', { rating: 5 }),
      mk('Unpublished', { isActive: false }),
      mk('Rejected', { moderation: { status: 'rejected' } }),
      mk('Dead brand', { brandId: id.deadBrand }),
      mk('Other cat', { categoryId: id.catB }),
    ]);
    ps.forEach((p) => (id[p.name] = String(p._id)));
    id.shopper = String(new ObjectId());
    await db.collection(Order.collection.name).insertMany([
      { odexId: 'O1', userId: new ObjectId(), items: [{ productId: ps[1]._id, quantity: 5 }], orderStatus: 'delivered', createdAt: new Date() },
      { odexId: 'O2', userId: new ObjectId(), items: [{ productId: ps[0]._id, quantity: 2 }], orderStatus: 'delivered', createdAt: new Date() },
      { odexId: 'O3', userId: new ObjectId(), items: [{ productId: ps[2]._id, quantity: 9 }], orderStatus: 'delivered', createdAt: new Date() },
    ]);

    // ── home services ──
    await db.collection('providers').createIndex({ currentLocation: '2dsphere' });
    const prov = (name, sub, lat, o = {}) => ({
      fullName: name, email: `${name}@x`, phoneNumber: name, providerType: 'home_service', providerSubType: sub,
      adminVerified: 'active', isActive: true, isAvailable: true, locationSource: 'profile',
      currentLocation: { type: 'Point', coordinates: [74.35, lat] }, ratings: { average: 4.5, count: 10 }, ...o,
    });
    const hp = await db.collection('providers').insertMany([
      prov('Plumber Near', 'plumber', 31.52),
      prov('Plumber Far', 'plumber', 31.60),
      prov('Plumber Hidden', 'plumber', 31.52, { hideFromSearch: true }),
      prov('Sparky', 'electrician', 31.521),
    ]);
    id.plumberNear = String(hp.insertedIds[0]);
    id.plumberHidden = String(hp.insertedIds[2]);
    id.sparky = String(hp.insertedIds[3]);
    id.customer = new ObjectId();
    await db.collection('hsbookings').insertMany([
      { customer: id.customer, serviceCategory: 'plumbers' },
      { customer: id.customer, serviceCategory: 'plumbers' },
    ]);
    await db.collection('hsproviderreviews').insertMany([
      { booking: new ObjectId(), customer: id.customer, provider: hp.insertedIds[3], rating: 5, createdAt: new Date() },
      { booking: new ObjectId(), customer: id.customer, provider: hp.insertedIds[2], rating: 5, createdAt: new Date() },
    ]);

    // ── healthcare ──
    await db.collection('clinics').createIndex({ location: '2dsphere' });
    const spec = await db.collection('specialties').insertOne({ name: 'Cardiology', isActive: true });
    const dp = await db.collection('providers').insertMany([
      { fullName: 'Dr Seen', providerType: 'doctor', email: 'd1@x', phoneNumber: 'd1' },
      { fullName: 'Dr Top', providerType: 'doctor', email: 'd2@x', phoneNumber: 'd2' },
      { fullName: 'Dr Pending', providerType: 'doctor', email: 'd3@x', phoneNumber: 'd3' },
    ]);
    const doc = (i, o) => ({ providerId: dp.insertedIds[i], specialtyId: spec.insertedId, verificationStatus: 'verified', isActive: true, ...o });
    const ds = await db.collection('doctors').insertMany([
      doc(0, { rating: 4.0, totalReviews: 5 }),
      doc(1, { rating: 4.9, totalReviews: 50 }),
      doc(2, { rating: 5.0, totalReviews: 90, verificationStatus: 'pending' }),
    ]);
    id.drSeen = String(ds.insertedIds[0]);
    id.drTop = String(ds.insertedIds[1]);
    id.patient = new ObjectId();
    await db.collection('appointments').insertOne({ patientId: id.patient, doctorId: ds.insertedIds[0], createdAt: new Date() });
    await db.collection('clinics').insertOne({ doctorId: ds.insertedIds[1], name: 'Heart Clinic', isActive: true, location: { type: 'Point', coordinates: [74.35, 31.53] } });
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  const names = (r) => r.items.map((i) => i.product.name);

  describe('shopping', () => {
    afterEach(() => db.collection('ml_user_recs').deleteMany({}).then(() => db.collection('ml_popular').deleteMany({})));

    it('with no batch yet, anonymous visitors get live best sellers — never a hidden product', async () => {
      const r = await recs.shoppingForUser(null);
      expect(r.source).toBe('popular');
      expect(names(r)).toEqual(['Visible B', 'Visible A']); // "Unpublished" sold most but is hidden
      expect(r.items[0].reason).toBe('Popular right now');
    });

    it('a signed-in shopper gets their batch list, re-checked against today\'s visibility', async () => {
      await db.collection('ml_user_recs').insertOne({
        userId: id.shopper, domain: 'shopping',
        items: [
          { id: id.Rejected, score: 9, reason: 'Because you liked X' },
          { id: id['Dead brand'], score: 8, reason: 'Because you liked X' },
          { id: id['Other cat'], score: 7, reason: 'Because you liked Visible A' },
        ],
      });
      await db.collection('ml_popular').insertOne({ domain: 'shopping', segment: 'all', items: [{ id: id['Visible A'], score: 3, reason: 'Popular right now' }] });
      const r = await recs.shoppingForUser(id.shopper);
      expect(r.source).toBe('personal');
      expect(names(r)).toEqual(['Other cat', 'Visible A']); // personal first, then popular; hidden ones dropped
      expect(r.items[0].reason).toBe('Because you liked Visible A');

      // Once they have bought it, the popular top-up stops offering it back.
      const Order = require('../../shopping/models/Order');
      await db.collection(Order.collection.name).insertOne({
        odexId: 'O-SHOPPER', userId: new ObjectId(id.shopper), items: [{ productId: new ObjectId(id['Visible A']), quantity: 1 }], orderStatus: 'delivered', createdAt: new Date(),
      });
      expect(names(await recs.shoppingForUser(id.shopper))).toEqual(['Other cat']);
      await db.collection(Order.collection.name).deleteOne({ odexId: 'O-SHOPPER' });
    });

    it('similar items: batch neighbours, topped up from the same category, never the product itself', async () => {
      await db.collection('ml_item_similarities').insertOne({
        domain: 'shopping', itemId: id['Visible A'],
        neighbors: [{ id: id['Other cat'], score: 0.9, reason: 'bought_together' }, { id: id.Unpublished, score: 0.8, reason: 'similar' }],
      });
      const r = await recs.similarProducts(id['Visible A']);
      expect(names(r)[0]).toBe('Other cat');
      expect(r.items[0].reason).toBe('Bought together');
      expect(names(r)).toContain('Visible B'); // same-category top-up
      expect(names(r)).not.toContain('Visible A');
      expect(names(r)).not.toContain('Unpublished');
    });

    it('inside a storefront every shelf stays in that store, topped up with its best rated', async () => {
      const other = (await db.collection('brands').insertOne({ odexId: 'B3', name: 'Other', slug: 'other', status: 'active', isDeleted: false })).insertedId;
      const Product = require('../../shopping/models/Product');
      const [own] = await Product.create([{ name: 'Store Only', brandId: other, categoryId: id.catA, basePrice: 500, isActive: true, inStock: true, rating: 3 }]);
      await db.collection('ml_popular').insertOne({ domain: 'shopping', segment: 'all', items: [{ id: id['Visible A'], score: 3, reason: 'Popular right now' }] });
      const r = await recs.shoppingForUser(null, { brandId: String(other) });
      expect(names(r)).toEqual(['Store Only']);
      expect(r.items[0].reason).toBe('Top rated in this store');
      expect(names(await recs.trending({ brandId: String(other) }))).toEqual(['Store Only']);
      // similar items of a product in the other store, viewed from this store
      expect(names(await recs.similarProducts(id['Visible A'], { brandId: String(other) }))).toEqual(['Store Only']);
      await Product.deleteOne({ _id: own._id });
    });

    it('trending uses the batch list when there is one', async () => {
      await db.collection('ml_popular').insertOne({ domain: 'shopping', segment: 'all', items: [{ id: id['Other cat'], score: 1, reason: 'Popular right now' }] });
      expect(names(await recs.trending())).toEqual(['Other cat']);
    });
  });

  describe('home services', () => {
    const origin = { lat: 31.52, lng: 74.35 };

    it('offers "book again" first, then the categories they book — through the search pipeline', async () => {
      const r = await recs.homeserviceForUser(String(id.customer), origin);
      expect(r.source).toBe('personal');
      const ids = r.items.map((i) => i.provider.id);
      expect(ids[0]).toBe(id.sparky);
      expect(r.items[0].reason).toBe('You rated them 5★ — book again');
      expect(ids).toContain(id.plumberNear);
      expect(ids).not.toContain(id.plumberHidden); // rated 5★, but hidden from search
      const plumber = r.items.find((i) => i.provider.id === id.plumberNear);
      expect(plumber.reason).toBe('Because you booked a plumber');
      expect(plumber.provider.distanceKm).toBe(0);
      expect(plumber.provider.email).toBeUndefined(); // public card
    });

    it('a customer with no history gets nothing rather than noise', async () => {
      const r = await recs.homeserviceForUser(String(new ObjectId()), origin);
      expect(r).toEqual({ source: 'none', items: [] });
    });

    it('the search-box preview ranks one category', async () => {
      const cards = await recs.discoverProviders('plumbers', origin, { limit: 3 });
      expect(cards.map((c) => c.name)).toEqual(['Plumber Near', 'Plumber Far']);
    });
  });

  describe('healthcare', () => {
    it('falls back to top-rated verified doctors in specialties the patient has seen, with distance', async () => {
      const r = await recs.doctorsForUser(String(id.patient), { lat: 31.52, lng: 74.35 });
      expect(r.source).toBe('history');
      expect(r.items.map((i) => String(i.doctor.id))).toEqual([id.drTop, id.drSeen]); // pending doctor excluded
      expect(r.items[0].doctor.providerId.fullName).toBe('Dr Top');
      expect(r.items[0].doctor.distanceKm).toBeCloseTo(1.1, 1);
      expect(r.items[1].doctor.distanceKm).toBeNull(); // no clinic placed
    });

    it('prefers the batch list when the nightly job has one', async () => {
      await db.collection('ml_user_recs').insertOne({ userId: String(id.patient), domain: 'healthcare', items: [{ id: id.drSeen, score: 1, reason: 'See again' }] });
      const r = await recs.doctorsForUser(String(id.patient), null);
      expect(r.source).toBe('personal');
      expect(r.items).toHaveLength(1);
      expect(r.items[0].reason).toBe('See again');
    });
  });

  describe('GET /api/search/services', () => {
    const express = require('express');
    const request = require('supertest');
    let app;
    beforeAll(() => {
      app = express();
      app.get('/search/services', require('../controllers/serviceSearchController').searchServices);
      app.use(require('../../../middleware/errorMiddleware').errorHandler);
    });

    it('maps a problem to a trade and previews its providers', async () => {
      const res = await request(app).get('/search/services').query({ q: 'kitchen tap is leaking', lat: 31.52, lng: 74.35 });
      expect(res.status).toBe(200);
      expect(res.body.data.interpreted).toMatchObject({ category: 'plumbers', label: 'Plumber', availableNow: false, source: 'rules' });
      expect(res.body.data.providers[0].name).toBe('Plumber Near');
    });

    it('says so when nobody is available right now, and still shows who could come', async () => {
      const res = await request(app).get('/search/services').query({ q: 'pipe burst, urgent' });
      expect(res.body.data.interpreted.availableNow).toBe(true);
      expect(res.body.data.noneAvailableNow).toBe(true); // nobody is online in the fixture
      expect(res.body.data.providers.length).toBeGreaterThan(0);
    });

    it('rejects an empty description', async () => {
      expect((await request(app).get('/search/services').query({ q: ' ' })).status).toBe(400);
    });
  });
});
