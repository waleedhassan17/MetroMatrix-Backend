/**
 * Read-through cache over the shared Redis (src/lib/redis.js).
 *
 *   const settings = await getOrSet(k('c', 'hs', 'settings'), 60, loadFromMongo);
 *
 * - Fail-open: with Redis absent, slow or down, the loader simply runs.
 * - Single-flight per instance: concurrent misses for one key share one load.
 * - Values are wrapped ({ v }) so a cached 0, '' or [] is a hit, not a miss.
 * - `ns(name)` / `bump(name)` give a versioned namespace, so a whole family of
 *   keys (e.g. every provider-search page) is invalidated with one INCR
 *   instead of a SCAN + DEL.
 *
 * Never put wallet, ledger, payment, commission or payout data in here.
 */

const { withRedis, k } = require('./redis');

const inflight = new Map();

async function getOrSet(key, ttlSec, loader) {
  const hit = await withRedis((r) => r.get(key));
  if (hit && typeof hit === 'object' && 'v' in hit) return hit.v;

  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await loader();
      if (value !== undefined) {
        // Fire-and-forget: the caller already has its answer.
        withRedis((r) => r.set(key, { v: value }, { ex: ttlSec }));
      }
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

async function del(...keys) {
  const list = keys.flat().filter(Boolean);
  if (!list.length) return 0;
  return withRedis((r) => r.del(...list), 0);
}

// Namespace versions are read often and change rarely: remember them briefly.
const NS_MEMO_MS = 5 * 1000;
const nsMemo = new Map();

/** Current version of a namespace (0 when Redis is unavailable). */
async function ns(name) {
  const memo = nsMemo.get(name);
  if (memo && Date.now() - memo.at < NS_MEMO_MS) return memo.v;
  const v = Number(await withRedis((r) => r.get(k('cv', name)), 0)) || 0;
  nsMemo.set(name, { v, at: Date.now() });
  return v;
}

/** Invalidate every key built from `ns(name)`. */
async function bump(name) {
  nsMemo.delete(name);
  return withRedis((r) => r.incr(k('cv', name)), 0);
}

/** JSON with sorted object keys, so {a,b} and {b,a} hash the same. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** Stable short hash of a filter object, for cache keys. */
function hashOf(value) {
  return require('crypto').createHash('sha1').update(stableStringify(value)).digest('hex').slice(0, 12);
}

module.exports = { getOrSet, del, ns, bump, hashOf, stableStringify };
