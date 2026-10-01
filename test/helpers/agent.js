const request = require('supertest');
const app = require('../../src/app');
const { DEFAULT_PASSWORD } = require('./factories');

const api = () => request(app);

/**
 * Sign an admin in through the real endpoint. Returns the response data
 * ({ accessToken, refreshToken, sessionId, restrict, admin, … }) plus a
 * bearer() helper for the access token.
 */
async function signIn(admin, { password = DEFAULT_PASSWORD, deviceLabel } = {}) {
  const res = await api().post('/api/admin/auth/login').send({ email: admin.email, password, deviceLabel });
  if (res.status !== 200 || res.body?.data?.step !== 'signed_in') {
    throw new Error(`signIn failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const data = res.body.data;
  return { ...data, bearer: () => `Bearer ${data.accessToken}` };
}

module.exports = { app, api, signIn };
