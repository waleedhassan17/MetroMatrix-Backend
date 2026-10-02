/**
 * Rate limiting, shared across every serverless instance.
 *
 * express-rate-limit's default MemoryStore counts per process. On Vercel each
 * lambda instance is its own process and cold starts reset it, so a limit of
 * "10 logins per 15 minutes" was really "10 per instance, per warm period".
 * The RedisStore below keeps one counter per key in Upstash — one EVAL per
 * request — and falls back to a per-instance MemoryStore whenever Redis is
 * absent or failing, which is exactly the old behaviour.
 *
 * The limits, keys and messages are unchanged from what app.js had.
 */
const rateLimit = require('express-rate-limit');
const { withRedis, k } = require('../lib/redis');

// INCR, set the window on first hit, report the count and remaining ms.
// PTTL < 0 means a key without expiry (a lost race): give it one.
const INCR_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
local t = redis.call('PTTL', KEYS[1])
if c == 1 or t < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  t = tonumber(ARGV[1])
end
return {c, t}
`;

class RedisStore {
  constructor(name) {
    this.name = name;
    this.localKeys = false;
    this.fallback = new rateLimit.MemoryStore();
  }

  init(options) {
    this.windowMs = options.windowMs;
    this.fallback.init(options);
  }

  key(key) {
    return k('rl', this.name, key);
  }

  async increment(key) {
    const reply = await withRedis((r) => r.eval(INCR_SCRIPT, [this.key(key)], [String(this.windowMs)]));
    if (Array.isArray(reply) && reply.length === 2) {
      const totalHits = Number(reply[0]);
      const ttl = Math.max(0, Number(reply[1]));
      return { totalHits, resetTime: new Date(Date.now() + ttl) };
    }
    return this.fallback.increment(key);
  }

  async decrement(key) {
    const ok = await withRedis((r) => r.decr(this.key(key)), null);
    if (ok === null) await this.fallback.decrement(key);
  }

  async resetKey(key) {
    await withRedis((r) => r.del(this.key(key)), null);
    await this.fallback.resetKey(key);
  }
}

// DISABLE_RATE_LIMIT exists ONLY so the local QA scripts (shopping-triage-probe,
// shopping-integrity, wallet-qa-gate) can run a full multi-role sweep without
// tripping the limiter and reporting throttled requests as product failures —
// which is exactly what happened before it existed. It is deliberately opt-in
// and is IGNORED in production, so a stray env var can never expose the
// deployed API.
function rateLimitDisabled() {
  return process.env.DISABLE_RATE_LIMIT === 'true' && process.env.NODE_ENV !== 'production';
}

// Signed-in traffic is limited PER ACCOUNT, anonymous traffic per IP.
//
// This was 100 requests per 10 minutes per IP for everything. One provider on
// the "awaiting approval" screen (which checks every 6 seconds) spends exactly
// that in ten minutes, after which every request of theirs — the approval
// check included — fails with 429. Mobile carriers in Pakistan also put many
// subscribers behind one public IP, so strangers were throttling each other.
// A verified token identifies the account; an invalid or forged one gets no
// bucket of its own and falls back to the IP.
const limiterKey = (req) => {
  if (req.rateLimitKey) return req.rateLimitKey;
  let key = `ip:${req.ip}`;
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    try {
      const decoded = require('jsonwebtoken').verify(header.slice(7), process.env.JWT_SECRET);
      if (decoded && decoded.id) key = `user:${decoded.id}`;
    } catch (e) {
      // expired or forged — rate-limited by address like any anonymous caller
    }
  }
  req.rateLimitKey = key;
  return key;
};

function buildLimiters() {
  const skip = () => rateLimitDisabled();
  const api = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    // ~2 requests a second on average for a signed-in account: room for every
    // polling screen at once; anonymous callers get a quarter of that.
    max: (req) => (limiterKey(req).startsWith('user:') ? 1200 : 300),
    keyGenerator: limiterKey,
    message: 'Too many requests, please try again in a few minutes.',
    skip,
    store: new RedisStore('api'),
  });

  // Auth rate limiting (stricter)
  const auth = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // limit each IP to 10 requests per windowMs
    skipSuccessfulRequests: true,
    message: 'Too many authentication attempts, please try again later.',
    skip,
    store: new RedisStore('auth'),
  });

  // Natural-language search calls an LLM: a tighter per-account budget.
  const nlq = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    keyGenerator: limiterKey,
    message: 'Too many searches, please slow down.',
    skip,
    store: new RedisStore('nlq'),
  });

  // Signed upload URLs: generous for a person, a wall for a script.
  const uploadSign = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 30,
    keyGenerator: limiterKey,
    message: 'Too many uploads, please wait a few minutes.',
    skip,
    store: new RedisStore('upload_sign'),
  });

  return { api, auth, nlq, uploadSign };
}

let shared = null;
/** One shared set of limiters for routes mounted from the registry. */
function limiter(name) {
  if (!shared) shared = buildLimiters();
  return shared[name];
}

module.exports = { buildLimiters, limiter, limiterKey, RedisStore, rateLimitDisabled, INCR_SCRIPT };
