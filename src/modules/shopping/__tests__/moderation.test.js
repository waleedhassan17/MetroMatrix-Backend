const { buildProductQuery, CUSTOMER_VISIBLE } = require('../services/catalogService');

describe('customer visibility', () => {
  it('requires published AND not held by moderation', () => {
    const q = buildProductQuery({});
    expect(q.isActive).toBe(true);
    expect(q['moderation.status']).toEqual({ $nin: ['pending', 'rejected', 'removed'] });
  });

  it('products from before moderation (no status) stay visible', () => {
    // $nin matches a missing field — no migration needed.
    expect(CUSTOMER_VISIBLE['moderation.status'].$nin).not.toContain(undefined);
    expect(CUSTOMER_VISIBLE['moderation.status'].$nin).not.toContain('approved');
  });
});

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('moderation flow (MongoDB)', () => {
  const mongoose = require('mongoose');
  jest.doMock('../../../sockets', () => ({ pushToUser: jest.fn().mockResolvedValue(true) }));
  const express = require('express');
  const request = require('supertest');
  let Product;
  let app;
  const admin = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    await mongoose.connect(URI.replace(/\/[^/]*$/, '/mm_moderation_test'));
    Product = require('../models/Product');
    require('../models/Brand');
    const { moderateProduct, listProducts } = require('../controllers/adminProductController');
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { _id: admin };
      next();
    });
    app.get('/admin/products', listProducts);
    app.patch('/admin/products/:productId/moderation', moderateProduct);
    app.use(require('../../../middleware/errorMiddleware').errorHandler);
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('a rejection needs a note; a removed product disappears for customers', async () => {
    const brandId = new mongoose.Types.ObjectId();
    const p = await Product.create({ brandId, name: 'Kurta', basePrice: 2500 });
    expect((await request(app).patch(`/admin/products/${p._id}/moderation`).send({ status: 'rejected' })).status).toBe(400);

    const r = await request(app).patch(`/admin/products/${p._id}/moderation`).send({ status: 'removed', note: 'Counterfeit' });
    expect(r.status).toBe(200);
    expect(r.body.data.moderation.status).toBe('removed');
    expect(await Product.countDocuments({ _id: p._id, ...buildProductQuery({}) })).toBe(0);

    const queue = await request(app).get('/admin/products?moderationStatus=removed');
    expect(queue.body.data.map((x) => x.name)).toEqual(['Kurta']);
  });

  it('legacy products without a status are listed as approved', async () => {
    await mongoose.connection.collection('shoppingproducts').insertOne({ brandId: new mongoose.Types.ObjectId(), name: 'Old Shawl', basePrice: 900, isActive: true });
    const res = await request(app).get('/admin/products?moderationStatus=approved');
    expect(res.body.data.map((x) => x.name)).toContain('Old Shawl');
  });
});
