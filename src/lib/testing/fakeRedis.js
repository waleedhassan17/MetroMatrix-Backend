/**
 * In-memory stand-in for the Upstash client — just the commands this codebase
 * uses. `failWith` makes every call reject, to exercise the fail-open paths.
 */
function createFakeRedis() {
  const data = new Map();
  const expiry = new Map();
  const zsets = new Map();
  const state = { failWith: null, calls: [] };

  const guard = (name, fn) => async (...args) => {
    state.calls.push(name);
    if (state.failWith) throw state.failWith;
    return fn(...args);
  };

  const fake = {
    state,
    data,
    get: guard('get', (key) => (data.has(key) ? data.get(key) : null)),
    set: guard('set', (key, value, opts = {}) => {
      if (opts.nx && data.has(key)) return null;
      data.set(key, value);
      if (opts.ex) expiry.set(key, opts.ex * 1000);
      return 'OK';
    }),
    del: guard('del', (...keys) => keys.reduce((n, key) => n + (data.delete(key) ? 1 : 0), 0)),
    incr: guard('incr', (key) => {
      const v = (Number(data.get(key)) || 0) + 1;
      data.set(key, v);
      return v;
    }),
    decr: guard('decr', (key) => {
      const v = (Number(data.get(key)) || 0) - 1;
      data.set(key, v);
      return v;
    }),
    // Emulates INCR_SCRIPT from gateway/rateLimit.js.
    eval: guard('eval', (script, keys, args) => {
      const key = keys[0];
      const c = (Number(data.get(key)) || 0) + 1;
      data.set(key, c);
      if (c === 1) expiry.set(key, Number(args[0]));
      return [c, expiry.get(key) || Number(args[0])];
    }),
    ping: guard('ping', () => 'PONG'),
    zadd: guard('zadd', (key, { score, member }) => {
      if (!zsets.has(key)) zsets.set(key, new Map());
      zsets.get(key).set(member, score);
      return 1;
    }),
    zcount: guard('zcount', (key, min, max) => {
      const z = zsets.get(key);
      if (!z) return 0;
      return [...z.values()].filter((s) => s >= Number(min) && s <= Number(max === '+inf' ? Infinity : max)).length;
    }),
    zremrangebyscore: guard('zremrangebyscore', () => 0),
    pipeline: () => {
      const ops = [];
      const p = {
        incrby: (key, n) => (ops.push(() => data.set(key, (Number(data.get(key)) || 0) + n)), p),
        expire: (key) => (ops.push(() => 1), p),
        exec: guard('exec', () => ops.map((op) => op())),
      };
      return p;
    },
  };
  return fake;
}

module.exports = { createFakeRedis };
