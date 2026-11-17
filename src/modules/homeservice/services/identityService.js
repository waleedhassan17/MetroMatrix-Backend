/**
 * "Is this really my provider?" — a doorstep identity check.
 *
 * The provider's app asks for a short-lived, single-use 6-digit code for ONE
 * job (POST /provider/jobs/:id/identity-token) and the provider reads it out.
 * The customer types it into their app, which sends it to
 * POST /bookings/:id/verify-identity.
 *
 * Why it can be trusted:
 *   - the code is stored only as a hash bound to the booking, so a code from
 *     another job (or a made-up one) is refused;
 *   - it expires after 10 minutes, and only the most recently issued code for
 *     a booking is live;
 *   - it works once: the first successful check clears it;
 *   - it allows 5 wrong guesses, then dies.
 */
const crypto = require('crypto');

const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

class IdentityError extends Error {
  constructor(message, status = 422, extra = {}) {
    super(message);
    this.statusCode = status;
    Object.assign(this, extra);
  }
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const codeHashFor = (bookingId, code) => sha(`${bookingId}:${String(code).trim()}`);

/**
 * A new code for a booking. `stored` goes on the booking
 * (booking.identityCheck); the code goes to the provider's screen only.
 */
function issue(bookingId, { now = Date.now() } = {}) {
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  const expiresAt = new Date(now + TOKEN_TTL_MS);
  return {
    code,
    expiresAt,
    stored: {
      codeHash: codeHashFor(bookingId, code),
      expiresAt,
      attempts: 0,
      issuedAt: new Date(now),
      verifiedAt: null,
      method: null,
    },
  };
}

module.exports = {
  issue,
  codeHashFor,
  IdentityError,
  TOKEN_TTL_MS,
  MAX_CODE_ATTEMPTS,
};
