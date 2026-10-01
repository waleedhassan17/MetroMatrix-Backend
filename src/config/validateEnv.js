/**
 * Fail fast on configuration that would make the API insecure or broken,
 * instead of discovering it one request at a time.
 *
 * Throws (so the process / serverless function refuses to start) when:
 *  - JWT_SECRET, REFRESH_TOKEN_SECRET or MONGODB_URI is missing;
 *  - JWT_SECRET === REFRESH_TOKEN_SECRET (a refresh token would then verify
 *    as an access token and vice versa);
 *  - in production, TOTP_ENC_KEY is missing or not 32 bytes (admin 2FA
 *    secrets are encrypted with it — without it 2FA admins cannot sign in).
 * Warns for optional integrations that fail closed on their own.
 */
const logger = require('../utils/logger');

function validateEnv(env = process.env) {
  const problems = [];

  for (const name of ['JWT_SECRET', 'REFRESH_TOKEN_SECRET', 'MONGODB_URI']) {
    if (!env[name]) problems.push(`${name} is not set`);
  }
  if (env.JWT_SECRET && env.JWT_SECRET === env.REFRESH_TOKEN_SECRET) {
    problems.push('JWT_SECRET and REFRESH_TOKEN_SECRET must be different');
  }

  if (env.NODE_ENV === 'production') {
    const key = env.TOTP_ENC_KEY ? Buffer.from(env.TOTP_ENC_KEY, 'base64') : null;
    if (!key || key.length !== 32) {
      problems.push('TOTP_ENC_KEY must be set to 32 random bytes, base64-encoded (e.g. `openssl rand -base64 32`)');
    }
  }

  if (problems.length) {
    const error = new Error(`Refusing to start — configuration problems:\n  - ${problems.join('\n  - ')}`);
    error.name = 'ConfigError';
    throw error;
  }

  if (!env.CRON_SECRET && !env.INTERNAL_API_KEY) {
    logger.warn('Neither CRON_SECRET nor INTERNAL_API_KEY is set — scheduled maintenance endpoints will reject every call.');
  }
}

module.exports = validateEnv;
