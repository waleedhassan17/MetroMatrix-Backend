/**
 * CORS as a browser meets it in production (src/gateway/security.js,
 * src/app.js, api/index.js).
 *
 * Native apps send no Origin and never notice CORS; the web build does. In
 * production the policy used to allow a handful of localhost ports and answer
 * every other origin, preflights included, with a 500 and no CORS headers —
 * so the web app failed as soon as it ran on 127.0.0.1, a LAN address or a
 * port Expo picked because 8081 was busy.
 */
const mongoose = require('mongoose');
const request = require('supertest');
const { connect, disconnect } = require('../../../test/helpers/db');
const { api } = require('../../../test/helpers/agent');

const ENV_KEYS = ['NODE_ENV', 'CORS_ORIGINS', 'CLIENT_URL'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  // Read per request by the origin check, so flipping it here is enough.
  process.env.NODE_ENV = 'production';
  delete process.env.CORS_ORIGINS;
  delete process.env.CLIENT_URL;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  jest.restoreAllMocks();
});

const get = (origin) => api().get('/health').set('Origin', origin);
const preflight = (app, origin, headers = 'authorization,content-type,x-best-effort') =>
  request(app)
    .options('/api/auth/login')
    .set('Origin', origin)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', headers);

describe('gateway CORS in production', () => {
  // A refused preflight continues into the maintenance check, which reads settings.
  beforeAll(connect);
  afterAll(disconnect);

  it.each([
    'http://localhost:8081',
    'http://localhost:8082',
    'http://localhost:8084', // a second Expo instance
    'http://localhost:19006',
    'http://127.0.0.1:8081',
    'https://localhost:8443',
  ])('allows the local web build at %s', async (origin) => {
    const res = await get(origin);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-expose-headers']).toMatch(/X-Request-Id/);
  });

  it('allows origins named in CORS_ORIGINS and CLIENT_URL, trailing slash or not', async () => {
    process.env.CORS_ORIGINS = ' https://web.example.com/ , http://192.168.1.10:8081';
    process.env.CLIENT_URL = 'https://app.example.com';
    for (const origin of ['https://web.example.com', 'http://192.168.1.10:8081', 'https://app.example.com']) {
      const res = await get(origin);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }
  });

  it.each([
    'https://evil.example.com',
    'http://192.168.1.10:8081', // a LAN address, until listed in CORS_ORIGINS
    'http://localhost.evil.com',
    'http://127.0.0.1.evil.com',
  ])('refuses %s without turning it into a server error', async (origin) => {
    const res = await get(origin);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a preflight with the requested headers and lets the browser cache it', async () => {
    const res = await preflight(require('../../app'), 'http://localhost:8084');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8084');
    expect(res.headers['access-control-allow-headers']).toBe('authorization,content-type,x-best-effort');
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  it('refuses a preflight from an unlisted origin without a 500', async () => {
    const res = await preflight(require('../../app'), 'https://evil.example.com');
    expect(res.status).toBeLessThan(500);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('keeps CORS headers on a body the JSON parser rejects', async () => {
    const res = await api()
      .post('/api/auth/login')
      .set('Origin', 'http://localhost:8082')
      .set('Content-Type', 'application/json')
      .send('{"email": ');
    expect(res.status).toBe(400);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8082');
  });

  it('is unchanged for native apps, which send no Origin', async () => {
    const res = await api().get('/health');
    expect(res.status).toBe(200);
  });
});

// No database connection from here on: the entry connects on demand.
describe('serverless entry (api/index.js)', () => {
  const handler = () => require('../../../api/index');

  it('refuses a preflight from an unlisted origin with a plain 204', async () => {
    const connect = jest.spyOn(mongoose, 'connect');
    const res = await preflight(handler(), 'https://evil.example.com');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
  });

  it('answers a preflight without waiting for the database', async () => {
    const connect = jest.spyOn(mongoose, 'connect');
    const res = await preflight(handler(), 'http://127.0.0.1:8081');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:8081');
    expect(connect).not.toHaveBeenCalled();
  });

  it('sends the database-down 500 with CORS headers, so the web app can read it', async () => {
    jest.spyOn(mongoose, 'connect').mockRejectedValue(new Error('unreachable'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(handler()).get('/api/shopping/products').set('Origin', 'http://localhost:8082');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Database connection failed');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8082');
  });
});
