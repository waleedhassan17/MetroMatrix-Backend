/**
 * The in-house TOTP implementation, pinned by RFC 6238 Appendix B (SHA-1).
 * The RFC lists 8-digit codes; authenticator apps use 6, which is the same
 * truncated value mod 10^6.
 */
const totp = require('../services/admin/totp');

const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP (RFC 6238)', () => {
  it.each(RFC_VECTORS)('t=%i → %s (8 digits)', (seconds, expected) => {
    expect(totp.totp(RFC_SECRET, seconds * 1000, { digits: 8 })).toBe(expected);
  });

  it.each(RFC_VECTORS)('t=%i → last 6 digits for authenticator apps', (seconds, expected) => {
    expect(totp.totp(RFC_SECRET, seconds * 1000)).toBe(expected.slice(-6));
  });

  it('base32 round-trips', () => {
    const bytes = Buffer.from('any binary \u0000ÿ secret', 'latin1');
    expect(totp.base32Decode(totp.base32Encode(bytes)).equals(bytes)).toBe(true);
  });

  it('accepts the current code and ±1 step of drift, not 2 steps', () => {
    const secret = totp.generateSecret();
    const raw = totp.base32Decode(secret);
    const now = 1_700_000_000_000;
    expect(totp.verifyTotp(secret, totp.totp(raw, now), { timeMs: now })).not.toBeNull();
    expect(totp.verifyTotp(secret, totp.totp(raw, now - 30_000), { timeMs: now })).not.toBeNull();
    expect(totp.verifyTotp(secret, totp.totp(raw, now + 30_000), { timeMs: now })).not.toBeNull();
    expect(totp.verifyTotp(secret, totp.totp(raw, now - 90_000), { timeMs: now })).toBeNull();
  });

  it('refuses a code whose step was already used (replay)', () => {
    const secret = totp.generateSecret();
    const now = 1_700_000_000_000;
    const code = totp.totp(totp.base32Decode(secret), now);
    const counter = totp.verifyTotp(secret, code, { timeMs: now });
    expect(counter).not.toBeNull();
    expect(totp.verifyTotp(secret, code, { timeMs: now, lastUsedCounter: counter })).toBeNull();
  });

  it('rejects malformed codes', () => {
    const secret = totp.generateSecret();
    for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined]) {
      expect(totp.verifyTotp(secret, bad)).toBeNull();
    }
  });

  it('encrypts secrets at rest (round trip, tamper-evident)', () => {
    const enc = totp.encryptSecret('JBSWY3DPEHPK3PXP');
    expect(enc).not.toContain('JBSWY3DPEHPK3PXP');
    expect(totp.decryptSecret(enc)).toBe('JBSWY3DPEHPK3PXP');
    const parts = enc.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => totp.decryptSecret(parts.join(':'))).toThrow();
  });

  it('recovery codes are stored as hashes and normalise formatting', () => {
    const { codes, hashes } = totp.generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(hashes[0]).toBe(totp.hashRecoveryCode(codes[0].toUpperCase().replace('-', ' ')));
  });

  it('builds an otpauth URL authenticator apps understand', () => {
    const url = new URL(totp.otpauthUrl('JBSWY3DPEHPK3PXP', 'ops@example.com'));
    expect(url.protocol).toBe('otpauth:');
    expect(url.searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(url.searchParams.get('issuer')).toBe('MetroMatrix Admin');
    expect(url.searchParams.get('period')).toBe('30');
  });
});
