/**
 * Shared Redis (Upstash, over HTTPS).
 *
 * Why HTTP and not a TCP client: this API runs as Vercel serverless functions.
 * A TCP connection per lambda instance would be opened on every cold start and
 * left dangling when the instance freezes; Upstash's REST client has no
 * connection to manage at all.
 *
 * Redis here is an ACCELERATOR, never a source of truth. Every caller goes
 * through `withRedis(fn, fallback)`, which:
 *   - answers `fallback` when Redis is not configured (local dev, tests, CI);
 *   - gives each call a hard timeout, so a slow Redis cannot slow the API;
 *   - opens a per-instance circuit after repeated failures, so an outage costs
 *     one timeout per 30 s per instance instead of one per request.
 *
 * Nothing that moves money may depend on it — see WALLET_DESIGN.md and the
 * guard test in src/__tests__/noCacheInMoneyPaths.test.js.
 */

const TIMEOUT_MS = Number(process.env.REDIS_TIMEOUT_MS) || 150;
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30 * 1000;

let client; // undefined = not resolved yet, null = not configured
let failures = 0;
let openUntil = 0;
let lastError = null;

function credentials() {
  // Vercel's Upstash integration injects KV_* names; a hand-made database uses UPSTASH_*.
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

function getClient() {
  if (client !== undefined) return client;
  const creds = credentials();
  if (!creds) {
    client = null;
    return client;
  }
  try {
    const { Redis } = require('@upstash/redis');
    client = new Redis({
      ...creds,
      // The default retries five times with backoff — seconds of latency
      // before the fallback could run. One quick retry is enough.
      retry: { retries: 1, backoff: () => 50 },
    });
  } catch (err) {
    console.warn('[redis] client unavailable:', err.message);
    client = null;
  }
  return client;
}

function redisEnabled() {
  return Boolean(getClient());
}

/** Namespaced key: every key this app writes starts with mm:<env>: */
function k(...parts) {
  const env = process.env.REDIS_ENV || process.env.NODE_ENV || 'dev';
  return ['mm', env, ...parts].join(':');
}

function timeout(ms) {
  return new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(`redis timeout after ${ms}ms`)), ms);
    if (t.unref) t.unref();
  });
}

/**
 * Run `fn(redis)` with a timeout; on any failure (or when Redis is absent or
 * the circuit is open) resolve `fallback` instead. Never rejects.
 */
async function withRedis(fn, fallback = null, { timeoutMs = TIMEOUT_MS } = {}) {
  const redis = getClient();
  if (!redis) return fallback;
  if (Date.now() < openUntil) return fallback;
  try {
    const result = await Promise.race([fn(redis), timeout(timeoutMs)]);
    failures = 0;
    return result;
  } catch (err) {
    failures += 1;
    lastError = { message: err.message, at: new Date().toISOString() };
    if (failures >= BREAKER_THRESHOLD) {
      openUntil = Date.now() + BREAKER_COOLDOWN_MS;
      failures = 0;
      console.warn(`[redis] circuit open for ${BREAKER_COOLDOWN_MS / 1000}s: ${err.message}`);
    }
    return fallback;
  }
}

/** 'up' | 'down' | 'disabled' — for /health. */
async function redisHealth() {
  if (!redisEnabled()) return 'disabled';
  const pong = await withRedis((r) => r.ping(), null, { timeoutMs: 500 });
  return pong ? 'up' : 'down';
}

function redisDiagnostics() {
  return {
    enabled: redisEnabled(),
    circuitOpen: Date.now() < openUntil,
    lastError,
  };
}

/** Test seam: inject a fake client (or null) and reset the breaker. */
function __setClientForTests(fake) {
  client = fake;
  failures = 0;
  openUntil = 0;
  lastError = null;
}

module.exports = {
  withRedis,
  redisEnabled,
  redisHealth,
  redisDiagnostics,
  k,
  __setClientForTests,
};
