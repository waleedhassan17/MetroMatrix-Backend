const express = require('express');
const request = require('supertest');
const redis = require('../../lib/redis');
const { createFakeRedis } = require('../../lib/testing/fakeRedis');
const { RedisStore, buildLimiters, limiterKey } = require('../rateLimit');

function appWith(limiter) {
  const app = express();
  app.set('trust proxy', 1);
  app.use('/api/auth/', limiter);
  app.post('/api/auth/login', (req, res) => res.status(401).json({ success: false }));
  return app;
}

describe('gateway RedisStore', () => {
  afterEach(() => redis.__setClientForTests(undefined));

  it('counts in Redis when it is available', async () => {
    const fake = createFakeRedis();
    redis.__setClientForTests(fake);
    const store = new RedisStore('t');
    store.init({ windowMs: 60000 });
    const a = await store.increment('ip:1');
    const b = await store.increment('ip:1');
    expect(a.totalHits).toBe(1);
    expect(b.totalHits).toBe(2);
    expect(b.resetTime).toBeInstanceOf(Date);
    expect(fake.state.calls.filter((c) => c === 'eval')).toHaveLength(2);
  });

  it('falls back to a per-instance MemoryStore when Redis fails', async () => {
    const fake = createFakeRedis();
    fake.state.failWith = new Error('down');
    redis.__setClientForTests(fake);
    const store = new RedisStore('t');
    store.init({ windowMs: 60000 });
    expect((await store.increment('ip:2')).totalHits).toBe(1);
    expect((await store.increment('ip:2')).totalHits).toBe(2);
  });

  it('enforces the auth limit across two instances sharing one Redis', async () => {
    const fake = createFakeRedis();
    redis.__setClientForTests(fake);
    // Two separately built limiters = two serverless instances.
    const one = appWith(buildLimiters().auth);
    const two = appWith(buildLimiters().auth);
    let last;
    for (let i = 0; i < 11; i += 1) {
      last = await request(i % 2 ? one : two).post('/api/auth/login').set('X-Forwarded-For', '9.9.9.9');
    }
    expect(last.status).toBe(429);
  });

  it('without Redis each instance counts on its own (the old behaviour)', async () => {
    redis.__setClientForTests(null);
    const one = appWith(buildLimiters().auth);
    const two = appWith(buildLimiters().auth);
    let last;
    for (let i = 0; i < 11; i += 1) {
      last = await request(i % 2 ? one : two).post('/api/auth/login').set('X-Forwarded-For', '8.8.8.8');
    }
    expect(last.status).toBe(401);
  });
});

describe('gateway limiterKey', () => {
  const jwt = require('jsonwebtoken');
  beforeAll(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  });

  it('keys a verified token by account', () => {
    const token = jwt.sign({ id: 'abc' }, process.env.JWT_SECRET);
    expect(limiterKey({ ip: '1.1.1.1', headers: { authorization: `Bearer ${token}` } })).toBe('user:abc');
  });

  it('keys a forged token by IP', () => {
    expect(limiterKey({ ip: '1.1.1.1', headers: { authorization: 'Bearer nope' } })).toBe('ip:1.1.1.1');
  });
});
