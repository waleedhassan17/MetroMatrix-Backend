/**
 * Server-to-server authentication for /api/internal/*.
 *
 * Two callers are trusted:
 *   - the realtime service and our own schedulers, with the shared
 *     `x-internal-key: <INTERNAL_API_KEY>` header;
 *   - Vercel Cron, which sends `Authorization: Bearer <CRON_SECRET>`.
 *
 * Both comparisons are timing-safe, and an UNSET secret never matches — so a
 * missing INTERNAL_API_KEY cannot be satisfied by a missing header.
 */
const crypto = require('crypto');

/** Timing-safe compare so the key cannot be discovered by response timing. */
function keyMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isInternalAuthorized(req) {
  const cronSecret = process.env.CRON_SECRET;
  return (
    keyMatches(req.headers['x-internal-key'], process.env.INTERNAL_API_KEY) ||
    Boolean(cronSecret && keyMatches(req.headers.authorization, `Bearer ${cronSecret}`))
  );
}

function requireInternalKey(req, res, next) {
  if (!isInternalAuthorized(req)) {
    res.status(401);
    return next(new Error('Not authorized'));
  }
  return next();
}

module.exports = { keyMatches, isInternalAuthorized, requireInternalKey };
