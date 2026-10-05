/**
 * One structured line per request, plus the cheap counters behind the admin
 * "live usage" tiles.
 *
 * The log line carries no body, no query string (verify/reset links carry
 * tokens there) and no personal data — only what is needed to trace a request:
 *   {"t":"req","id":"…","m":"GET","p":"/api/providers","s":200,"ms":41,"role":"user"}
 *
 * Usage metrics are written to Redis WITHOUT costing a command per request:
 *   - request/error counts accumulate in memory and are flushed with INCRBY at
 *     most every FLUSH_MS per instance;
 *   - "active accounts" is a ZSET touched at most once per account per minute
 *     per instance.
 * Everything here is fire-and-forget and fail-open.
 */
const { withRedis, k, redisEnabled } = require('../lib/redis');

const FLUSH_MS = 10 * 1000;
const ACTIVE_TOUCH_MS = 60 * 1000;

const pending = { requests: 0, errors: 0 };
let lastFlush = Date.now();
const lastTouch = new Map();

function minuteKey(date = new Date()) {
  return date.toISOString().slice(0, 16).replace(/[-:T]/g, ''); // yyyyMMddHHmm (UTC)
}

function roleOf(req) {
  if (req.isAdmin) return 'admin';
  if (req.isProvider) return 'provider';
  if (req.user) return 'user';
  return null;
}

function flushCounters(force = false) {
  if (!redisEnabled()) return;
  if (!force && Date.now() - lastFlush < FLUSH_MS) return;
  const { requests, errors } = pending;
  pending.requests = 0;
  pending.errors = 0;
  lastFlush = Date.now();
  if (!requests && !errors) return;
  const minute = minuteKey();
  withRedis(async (r) => {
    const p = r.pipeline();
    if (requests) {
      p.incrby(k('metrics', 'req', minute), requests);
      p.expire(k('metrics', 'req', minute), 2 * 60 * 60);
    }
    if (errors) {
      p.incrby(k('metrics', 'err', minute), errors);
      p.expire(k('metrics', 'err', minute), 2 * 60 * 60);
    }
    return p.exec();
  });
}

function touchActive(req) {
  const role = roleOf(req);
  if (!role || !req.user || !req.user._id || !redisEnabled()) return;
  const id = String(req.user._id);
  const memoKey = `${role}:${id}`;
  const now = Date.now();
  if (now - (lastTouch.get(memoKey) || 0) < ACTIVE_TOUCH_MS) return;
  lastTouch.set(memoKey, now);
  if (lastTouch.size > 5000) lastTouch.clear(); // bound memory on a long-lived instance
  withRedis((r) => r.zadd(k('rt', 'active', role), { score: now, member: id }));
}

function accessLog(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number((process.hrtime.bigint() - started) / 1000000n);
    const path = (req.originalUrl || req.url || '').split('?')[0];
    const isApi = path.startsWith('/api/');

    if (isApi) {
      pending.requests += 1;
      if (res.statusCode >= 500) pending.errors += 1;
      flushCounters();
      touchActive(req);
    }

    if (process.env.ACCESS_LOG === 'off') return;
    if (process.env.NODE_ENV === 'test') return;
    // `morgan('dev')` already prints a friendlier line in development.
    if (process.env.NODE_ENV === 'development' && process.env.ACCESS_LOG !== 'json') return;
    console.log(
      JSON.stringify({
        t: 'req',
        id: req.id,
        m: req.method,
        p: path,
        s: res.statusCode,
        ms,
        role: roleOf(req),
      })
    );
  });
  next();
}

module.exports = { accessLog, minuteKey, flushCounters, __pending: pending };
