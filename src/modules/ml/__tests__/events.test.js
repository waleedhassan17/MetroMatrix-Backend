jest.mock('../models/MlEvent', () => {
  const insertMany = jest.fn(async (docs) => docs);
  const create = jest.fn(async (doc) => doc);
  return Object.assign(
    { insertMany, create },
    {
      MODULES: ['shopping', 'homeservice', 'healthcare'],
      TYPES: ['impression', 'view', 'click', 'search', 'add_to_cart', 'wishlist', 'book', 'order', 'appointment'],
    }
  );
});

const express = require('express');
const request = require('supertest');
const MlEvent = require('../models/MlEvent');
const { sanitizeEvent, recordEvents } = require('../services/eventService');
const { postEvents } = require('../controllers/eventController');
const { errorHandler } = require('../../../middleware/errorMiddleware');

const USER = '64b7f0c2a1b2c3d4e5f60718';

describe('ml sanitizeEvent', () => {
  const now = new Date('2026-10-01T10:00:00Z');

  it('keeps a valid event and stamps the verified actor', () => {
    const e = sanitizeEvent(
      { module: 'shopping', type: 'view', refId: 'p1', meta: { position: 3, evil: { $gt: 1 } } },
      { userId: USER, role: 'user' },
      now
    );
    expect(e).toMatchObject({ module: 'shopping', type: 'view', refId: 'p1', userId: USER, role: 'user', source: 'app' });
    expect(e.meta).toEqual({ position: 3 });
  });

  it('drops unknown modules and types', () => {
    expect(sanitizeEvent({ module: 'wallet', type: 'view' }, {}, now)).toBeNull();
    expect(sanitizeEvent({ module: 'shopping', type: 'purchase' }, {}, now)).toBeNull();
    expect(sanitizeEvent(null, {}, now)).toBeNull();
  });

  it('truncates strings and keeps features only on impressions', () => {
    const long = 'x'.repeat(500);
    const e = sanitizeEvent({ module: 'shopping', type: 'search', query: long, features: { a: 1 } }, {}, now);
    expect(e.query).toHaveLength(120);
    expect(e.features).toBeUndefined();
    const imp = sanitizeEvent(
      { module: 'homeservice', type: 'impression', features: { dist_km: 2.5, bad: 'str', $where: 1 } },
      {},
      now
    );
    expect(imp.features).toEqual({ dist_km: 2.5 });
  });

  it('accepts a recent client timestamp but not a future or ancient one', () => {
    const recent = sanitizeEvent({ module: 'shopping', type: 'view', ts: '2026-10-01T09:30:00Z' }, {}, now);
    expect(recent.ts.toISOString()).toBe('2026-10-01T09:30:00.000Z');
    expect(sanitizeEvent({ module: 'shopping', type: 'view', ts: '2030-01-01' }, {}, now).ts).toBe(now);
    expect(sanitizeEvent({ module: 'shopping', type: 'view', ts: '2020-01-01' }, {}, now).ts).toBe(now);
  });

  it('ignores a userId that is not an ObjectId', () => {
    expect(sanitizeEvent({ module: 'shopping', type: 'view' }, { userId: 'nope' }, now).userId).toBeNull();
  });
});

describe('ml recordEvents', () => {
  beforeEach(() => MlEvent.insertMany.mockClear());

  it('caps the batch at 50 and drops malformed events', async () => {
    const events = Array.from({ length: 60 }, (_, i) => ({ module: 'shopping', type: i % 10 ? 'view' : 'bogus' }));
    const n = await recordEvents(events, {});
    expect(n).toBe(45); // 50 kept by the cap, 5 of them malformed
    expect(MlEvent.insertMany).toHaveBeenCalledTimes(1);
  });

  it('writes nothing for an empty or all-bad batch', async () => {
    expect(await recordEvents([{ module: 'x' }], {})).toBe(0);
    expect(MlEvent.insertMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/events', () => {
  const app = express();
  app.use(express.json());
  app.post('/api/events', postEvents);
  app.use(errorHandler);

  it('answers 202 with the accepted count', async () => {
    const res = await request(app)
      .post('/api/events')
      .send({ events: [{ module: 'healthcare', type: 'view', refId: 'd1' }] });
    expect(res.status).toBe(202);
    expect(res.body.data.accepted).toBe(1);
  });

  it('rejects a body without an events array', async () => {
    const res = await request(app).post('/api/events').send({ events: 'nope' });
    expect(res.status).toBe(400);
  });
});
