const crypto = require('crypto');
const asyncHandler = require('express-async-handler');
const { expireStale } = require('../services/expiryService');

// ============================================================================
// The daily backstop for request expiry.
//
// Expiry is applied lazily wherever a booking is shown (services/
// expiryService.js), which closes a stale row the moment anyone could see it.
// This sweep catches the rows nobody looks at, so the database itself stays
// honest. Vercel Cron calls it — the same pattern as the healthcare slot
// horizon (modules/healthcare/controllers/slotHorizonController.js), because
// serverless has no timer of its own.
// ============================================================================

/** Timing-safe compare so the key cannot be discovered by response timing. */
function keyMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * GET|POST /api/internal/homeservice/expire
 *
 * Accepts either the shared internal key or Vercel Cron's own bearer token.
 */
const runExpiry = asyncHandler(async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  const authorized =
    keyMatches(req.headers['x-internal-key'], process.env.INTERNAL_API_KEY) ||
    (cronSecret && req.headers.authorization === `Bearer ${cronSecret}`);
  if (!authorized) {
    res.status(401);
    throw new Error('Not authorized');
  }

  const closed = await expireStale({});
  console.log(`[expiry] daily sweep closed ${closed} booking(s)`);
  res.json({ success: true, data: { closed } });
});

module.exports = { runExpiry };
