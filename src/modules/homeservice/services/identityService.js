/**
 * "Is this really my provider?" — a doorstep identity check.
 *
 * The provider's app asks for a short-lived, single-use proof for ONE job
 * (POST /provider/jobs/:id/identity-token) and offers it three ways:
 *   - written to an NFC sticker/badge the provider carries (an NDEF URI record:
 *     metromatrix://verify?t=<token>) — the customer taps it with their phone;
 *   - shown as a QR code — the customer scans it;
 *   - read out as a 6-digit code — for phones with neither NFC nor a camera.
 * The customer's app sends what it read to POST /bookings/:id/verify-identity.
 *
 * Why it can be trusted:
 *   - the token is HMAC-signed by the server and names the booking, so a token
 *     for another job (or a made-up one) is refused;
 *   - it expires after 10 minutes, and only the most recently issued token for
 *     a booking is live (its nonce is stored hashed on the booking);
 *   - it works once: the first successful check clears it;
 *   - the 6-digit code allows 5 wrong guesses, then dies.
 * Android dropped phone-to-phone NFC (Beam) in Android 10, which is why the
 * provider writes to a tag rather than "beaming" from their phone.
 *
 * Kept short on purpose (~77 characters) so the NFC record fits an NTAG213,
 * the cheapest sticker (144 bytes).
 */
const crypto = require('crypto');

const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const PREFIX = 'mmid1';
const NFC_URI_PREFIX = 'metromatrix://verify?t=';

class IdentityError extends Error {
  constructor(message, status = 422, extra = {}) {
    super(message);
    this.statusCode = status;
    Object.assign(this, extra);
  }
}

function secret() {
  if (process.env.NFC_TOKEN_SECRET) return process.env.NFC_TOKEN_SECRET;
  if (!process.env.JWT_SECRET) throw new Error('No signing secret configured (NFC_TOKEN_SECRET)');
  // Derived, never the JWT secret itself, so these tokens can never help forge a session.
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update('mm:identity-token:v1').digest('hex');
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sign = (body) => crypto.createHmac('sha256', secret()).update(body).digest().subarray(0, 16).toString('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * A new token + code for a booking. `stored` goes on the booking
 * (booking.identityCheck); the token and code go to the provider's screen only.
 */
function issue(bookingId, { now = Date.now() } = {}) {
  const nonce = crypto.randomBytes(9).toString('base64url'); // 12 chars
  const exp = Math.floor((now + TOKEN_TTL_MS) / 1000);
  const body = `${PREFIX}.${String(bookingId)}.${nonce}.${exp}`;
  const token = `${body}.${sign(body)}`;
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  return {
    token,
    code,
    // Same token; `via` only records how it reached the customer's phone. A
    // phone that opens the link from the system (badge tapped with the app
    // closed, QR scanned with the camera app) lands on the verify screen.
    nfcUri: `${NFC_URI_PREFIX}${token}&via=nfc`,
    qrPayload: `${NFC_URI_PREFIX}${token}&via=qr`,
    expiresAt: new Date(exp * 1000),
    stored: {
      nonceHash: sha(nonce),
      codeHash: sha(`${bookingId}:${code}`),
      expiresAt: new Date(exp * 1000),
      attempts: 0,
      issuedAt: new Date(now),
      verifiedAt: null,
      method: null,
    },
  };
}

/** The token inside an NFC URI, a QR payload or a raw string. */
function extractToken(input) {
  const s = String(input || '').trim();
  if (!s.startsWith('metromatrix://')) return s;
  const query = s.split('?')[1] || '';
  const pair = query.split('&').find((p) => p.startsWith('t='));
  return pair ? decodeURIComponent(pair.slice(2)) : '';
}

/** → { bookingId, nonceHash, exp } or throws IdentityError. Does not check the booking's state. */
function readToken(input, { now = Date.now() } = {}) {
  const token = extractToken(input);
  const m = /^(mmid1\.([a-f0-9]{24})\.([A-Za-z0-9_-]{12})\.(\d{10}))\.([A-Za-z0-9_-]{22})$/.exec(token);
  if (!m) throw new IdentityError("That isn't a MetroMatrix ID code", 400);
  if (!safeEqual(sign(m[1]), m[5])) throw new IdentityError("That ID code isn't genuine");
  const exp = Number(m[4]) * 1000;
  if (exp < now) throw new IdentityError('That ID code has expired — ask the provider to show a new one');
  return { bookingId: m[2], nonceHash: sha(m[3]), exp };
}

const codeHashFor = (bookingId, code) => sha(`${bookingId}:${String(code).trim()}`);

module.exports = {
  issue,
  readToken,
  extractToken,
  codeHashFor,
  IdentityError,
  TOKEN_TTL_MS,
  MAX_CODE_ATTEMPTS,
  NFC_URI_PREFIX,
};
