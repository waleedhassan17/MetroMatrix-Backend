const redis = require('../redis');
const { getOrSet, del, ns, bump, hashOf } = require('../cache');
const { createFakeRedis } = require('../testing/fakeRedis');

describe('lib/redis withRedis', () => {
  afterEach(() => redis.__setClientForTests(undefined));

  it('answers the fallback when Redis is not configured', async () => {
    redis.__setClientForTests(null);
    expect(await redis.withRedis((r) => r.get('x'), 'fallback')).toBe('fallback');
    expect(redis.redisEnabled()).toBe(false);
    expect(await redis.redisHealth()).toBe('disabled');
  });

  it('answers the fallback when a call fails, and opens the circuit after 3 failures', async () => {
    const fake = createFakeRedis();
    fake.state.failWith = new Error('boom');
    redis.__setClientForTests(fake);
    for (let i = 0; i < 3; i += 1) {
      expect(await redis.withRedis((r) => r.get('x'), 'fb')).toBe('fb');
    }
    expect(fake.state.calls).toHaveLength(3);
    // Circuit open: the client is not even called.
    expect(await redis.withRedis((r) => r.get('x'), 'fb')).toBe('fb');
    expect(fake.state.calls).toHaveLength(3);
    expect(redis.redisDiagnostics().circuitOpen).toBe(true);
  });

  it('times out a slow call', async () => {
    redis.__setClientForTests({ get: () => new Promise(() => {}) });
    expect(await redis.withRedis((r) => r.get('x'), 'late', { timeoutMs: 20 })).toBe('late');
  });

  it('namespaces keys by environment', () => {
    expect(redis.k('c', 'hs', 'settings')).toMatch(/^mm:[a-z]+:c:hs:settings$/);
  });
});

describe('lib/cache getOrSet', () => {
  afterEach(() => redis.__setClientForTests(undefined));

  it('runs the loader when Redis is absent (fail-open)', async () => {
    redis.__setClientForTests(null);
    const loader = jest.fn().mockResolvedValue({ a: 1 });
    expect(await getOrSet('k1', 60, loader)).toEqual({ a: 1 });
    expect(await getOrSet('k1', 60, loader)).toEqual({ a: 1 });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('runs the loader when Redis throws (fail-open)', async () => {
    const fake = createFakeRedis();
    fake.state.failWith = new Error('down');
    redis.__setClientForTests(fake);
    const loader = jest.fn().mockResolvedValue(42);
    expect(await getOrSet('k2', 60, loader)).toBe(42);
  });

  it('caches values, including falsy ones', async () => {
    const fake = createFakeRedis();
    redis.__setClientForTests(fake);
    const loader = jest.fn().mockResolvedValue(0);
    expect(await getOrSet('k3', 60, loader)).toBe(0);
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget set land
    expect(await getOrSet('k3', 60, loader)).toBe(0);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('shares one load between concurrent misses (single-flight)', async () => {
    redis.__setClientForTests(null);
    let resolve;
    const loader = jest.fn(() => new Promise((r) => (resolve = r)));
    const a = getOrSet('k4', 60, loader);
    const b = getOrSet('k4', 60, loader);
    await new Promise((r) => setImmediate(r));
    resolve('v');
    expect(await Promise.all([a, b])).toEqual(['v', 'v']);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('does not cache a loader failure', async () => {
    const fake = createFakeRedis();
    redis.__setClientForTests(fake);
    const loader = jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce('ok');
    await expect(getOrSet('k5', 60, loader)).rejects.toThrow('db down');
    expect(await getOrSet('k5', 60, loader)).toBe('ok');
  });

  it('del removes keys; ns/bump version a namespace', async () => {
    const fake = createFakeRedis();
    redis.__setClientForTests(fake);
    await fake.set('a', { v: 1 });
    expect(await del('a')).toBe(1);
    expect(await ns('search')).toBe(0);
    await bump('search');
    expect(await ns('search')).toBe(1);
  });

  it('hashOf is stable under key order', () => {
    expect(hashOf({ a: 1, b: { c: 2, d: 3 } })).toBe(hashOf({ b: { d: 3, c: 2 }, a: 1 }));
    expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }));
  });
});
