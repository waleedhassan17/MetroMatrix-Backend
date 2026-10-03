/**
 * Start-up configuration checks and the readiness endpoint (QA Q35).
 */
const { connect, disconnect } = require('../../test/helpers/db');
const { api } = require('../../test/helpers/agent');
const validateEnv = require('../config/validateEnv');

const base = {
  JWT_SECRET: 'a'.repeat(32),
  REFRESH_TOKEN_SECRET: 'b'.repeat(32),
  MONGODB_URI: 'mongodb://127.0.0.1/x',
  NODE_ENV: 'development',
};

describe('validateEnv (start-up)', () => {
  it('accepts a sane configuration', () => {
    expect(() => validateEnv(base)).not.toThrow();
  });

  it.each(['JWT_SECRET', 'REFRESH_TOKEN_SECRET', 'MONGODB_URI'])('refuses to start without %s', (name) => {
    expect(() => validateEnv({ ...base, [name]: '' })).toThrow(`${name} is not set`);
  });

  it('refuses equal access and refresh secrets', () => {
    expect(() => validateEnv({ ...base, REFRESH_TOKEN_SECRET: base.JWT_SECRET })).toThrow(/must be different/);
  });

  it('in production, refuses a missing or malformed TOTP_ENC_KEY', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow(/TOTP_ENC_KEY/);
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', TOTP_ENC_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/TOTP_ENC_KEY/);
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', TOTP_ENC_KEY: Buffer.alloc(32, 1).toString('base64') })).not.toThrow();
  });
});

describe('GET /health/ready', () => {
  afterAll(disconnect);

  it('is not ready without a database', async () => {
    const res = await api().get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.checks.database).toMatch(/failing/);
  });

  it('is ready with a database and a sane configuration', async () => {
    await connect();
    const res = await api().get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ready', checks: { database: 'ok', configuration: 'ok' } });
  });

  it('reports a broken configuration', async () => {
    const original = process.env.REFRESH_TOKEN_SECRET;
    process.env.REFRESH_TOKEN_SECRET = process.env.JWT_SECRET;
    try {
      const res = await api().get('/health/ready');
      expect(res.status).toBe(503);
      expect(res.body.checks.configuration).toBe('failing');
    } finally {
      process.env.REFRESH_TOKEN_SECRET = original;
    }
  });
});
