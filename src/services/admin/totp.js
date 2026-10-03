const crypto = require('crypto');
const logger = require('../../utils/logger');

/**
 * TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30 s) for admin two-factor sign-in —
 * the default every authenticator app (Google Authenticator, Microsoft
 * Authenticator, 1Password, Authy…) speaks. Implemented here rather than via a
 * dependency because it is ~60 lines and is pinned by the RFC's own test
 * vectors in __tests__/adminTotp.test.js.
 *
 * Secrets are stored encrypted (AES-256-GCM, key TOTP_ENC_KEY), recovery
 * codes only as SHA-256 hashes.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
const ISSUER = 'MetroMatrix Admin';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// RFC 4226 HOTP.
function hotp(secret, counter, { digits = DIGITS, algorithm = 'sha1' } = {}) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac(algorithm, secret).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

const counterAt = (timeMs) => Math.floor(timeMs / 1000 / STEP_SECONDS);

function totp(secret, timeMs = Date.now(), opts) {
  return hotp(secret, counterAt(timeMs), opts);
}

/**
 * Check a code against the current step ±`window` steps (clock drift).
 * Returns the matched counter, or null. A code whose counter is not greater
 * than `lastUsedCounter` is refused, so an observed code can't be replayed.
 */
function verifyTotp(secretBase32, code, { window = 1, timeMs = Date.now(), lastUsedCounter = 0 } = {}) {
  const normalised = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalised)) return null;
  const secret = base32Decode(secretBase32);
  const now = counterAt(timeMs);
  for (let delta = -window; delta <= window; delta += 1) {
    const counter = now + delta;
    if (counter <= lastUsedCounter) continue;
    const expected = hotp(secret, counter);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(normalised))) return counter;
  }
  return null;
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

function otpauthUrl(secretBase32, account) {
  const label = `${encodeURIComponent(ISSUER)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret: secretBase32, issuer: ISSUER, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---- secret encryption at rest ----

let warnedDerivedKey = false;
function encryptionKey() {
  if (process.env.TOTP_ENC_KEY) {
    const key = Buffer.from(process.env.TOTP_ENC_KEY, 'base64');
    if (key.length === 32) return key;
    throw new Error('TOTP_ENC_KEY must be 32 bytes, base64-encoded');
  }
  // Development convenience only — validateEnv refuses to start production
  // without TOTP_ENC_KEY.
  if (process.env.NODE_ENV === 'production') throw new Error('TOTP_ENC_KEY is not set');
  if (!warnedDerivedKey) {
    logger.warn('TOTP_ENC_KEY not set — deriving a development key from JWT_SECRET');
    warnedDerivedKey = true;
  }
  return crypto.createHash('sha256').update(`totp:${process.env.JWT_SECRET || ''}`).digest();
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decryptSecret(stored) {
  const [version, iv, tag, ct] = String(stored || '').split(':');
  if (version !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised TOTP secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

// ---- recovery codes ----

const RECOVERY_CODE_COUNT = 10;
const hashRecoveryCode = (code) =>
  crypto.createHash('sha256').update(String(code).toLowerCase().replace(/[^a-z2-7]/g, '')).digest('hex');

function generateRecoveryCodes() {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = base32Encode(crypto.randomBytes(5)).toLowerCase(); // 8 chars
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
  });
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

module.exports = {
  base32Encode,
  base32Decode,
  hotp,
  totp,
  verifyTotp,
  generateSecret,
  otpauthUrl,
  encryptSecret,
  decryptSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  STEP_SECONDS,
  ISSUER,
};
