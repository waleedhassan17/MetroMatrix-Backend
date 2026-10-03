/**
 * docs/admin.openapi.yaml is the contract between this API and the admin app
 * (the app generates its types from it). This test keeps it true:
 *  - every admin route has an operation in the spec, and every operation is a
 *    real route (no drift either way);
 *  - real responses — success and failure — satisfy the spec's schemas.
 */
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const mongoose = require('mongoose');
const jestOpenAPI = require('jest-openapi').default;
const { connect, clear, disconnect } = require('../../test/helpers/db');
const { createAdmin, createProvider, createUser, createWallet } = require('../../test/helpers/factories');
const { app, api, signIn } = require('../../test/helpers/agent');
const { routeTable } = require('../utils/routeTable');
const notifications = require('../services/notificationService');

const SPEC_PATH = path.join(__dirname, '..', '..', 'docs', 'admin.openapi.yaml');
jestOpenAPI(SPEC_PATH);

const ADMIN_PREFIX = /^\/api\/(admin|v1\/admin|shopping\/admin)(\/|$)/;
// Express path → OpenAPI path: drop a trailing slash and any :param(regex)
// constraint, then :param → {param}.
const normalise = (p) => p.replace(/\/+$/, '').replace(/\([^)]*\)/g, '').replace(/:(\w+)/g, '{$1}');

describe('spec ⟷ routes', () => {
  const spec = yaml.load(fs.readFileSync(SPEC_PATH, 'utf8'));
  const specOps = Object.entries(spec.paths).flatMap(([p, methods]) => Object.keys(methods).map((m) => `${m.toUpperCase()} ${p}`));
  const routeOps = routeTable(app)
    .filter((r) => ADMIN_PREFIX.test(r.path))
    .map((r) => `${r.method} ${normalise(r.path)}`);

  it('every admin route is in the spec', () => {
    expect(routeOps.filter((op) => !specOps.includes(op))).toEqual([]);
  });

  it('every operation in the spec is a real route', () => {
    expect(specOps.filter((op) => !routeOps.includes(op))).toEqual([]);
  });
});

describe('responses satisfy the spec', () => {
  beforeAll(connect);
  afterEach(clear);
  afterAll(disconnect);

  const as = (s) => ({
    get: (p) => api().get(p).set('Authorization', s.bearer()),
    put: (p, b) => api().put(p).set('Authorization', s.bearer()).send(b || {}),
    post: (p, b) => api().post(p).set('Authorization', s.bearer()).send(b || {}),
    patch: (p, b) => api().patch(p).set('Authorization', s.bearer()).send(b || {}),
    del: (p, b) => api().delete(p).set('Authorization', s.bearer()).send(b || {}),
  });

  it('authentication and own account', async () => {
    const admin = await createAdmin({ role: 'super_admin' });
    const login = await api().post('/api/admin/auth/login').send({ email: admin.email, password: 'Correct-Horse-Battery-9' });
    expect(login.status).toBe(200);
    expect(login).toSatisfyApiSpec();
    const refresh = await api().post('/api/admin/auth/refresh-token').send({ refreshToken: login.body.data.refreshToken });
    expect(refresh).toSatisfyApiSpec();
    const s = { bearer: () => `Bearer ${refresh.body.data.accessToken}` };
    for (const p of ['/api/admin/profile', '/api/admin/sessions', '/api/admin/meta', '/api/admin/overview', '/api/admin/queue', '/api/admin/settings']) {
      const res = await as(s).get(p);
      expect([p, res.status]).toEqual([p, 200]);
      expect(res).toSatisfyApiSpec();
    }
    const enrol = await as(s).post('/api/admin/auth/2fa/enrol', { currentPassword: 'Correct-Horse-Battery-9' });
    expect(enrol).toSatisfyApiSpec();
    const bad = await api().post('/api/admin/auth/login').send({ email: admin.email, password: 'nope' });
    expect(bad.status).toBe(401);
    expect(bad).toSatisfyApiSpec();
  });

  it('providers, users and notifications', async () => {
    const s = await signIn(await createAdmin({ role: 'super_admin' }));
    const provider = await createProvider({ submittedAt: new Date(), status: 'pending_review' });
    const user = await createUser();
    await notifications.notifyPayoutRequested({ _id: new mongoose.Types.ObjectId(), amount: 10 }, 'X');
    const calls = [
      () => as(s).get('/api/admin/providers?state=pending'),
      () => as(s).get(`/api/admin/providers/${provider._id}`),
      () => as(s).put(`/api/admin/providers/${provider._id}/approve`),
      () => as(s).put(`/api/admin/providers/${provider._id}/suspend`, { reason: 'checks' }),
      () => as(s).get('/api/admin/users'),
      () => as(s).get(`/api/admin/users/${user._id}`),
      () => as(s).put(`/api/admin/users/${user._id}/deactivate`, { reason: 'fraud check' }),
      () => as(s).del(`/api/admin/users/${user._id}`, { reason: 'requested' }),
      () => as(s).get('/api/admin/notifications'),
      () => as(s).get('/api/admin/notifications/unread-count'),
      () => as(s).put('/api/admin/notifications/read-all'),
      () => as(s).get('/api/admin/analytics'),
    ];
    for (const call of calls) {
      const res = await call();
      expect(res.status).toBeLessThan(300);
      expect(res).toSatisfyApiSpec();
    }
  });

  it('settings, admins and finance', async () => {
    const s = await signIn(await createAdmin({ role: 'super_admin' }));
    const wallet = await createWallet(new mongoose.Types.ObjectId(), 'User', 100);
    const created = await as(s).post('/api/admin/admins', { email: 'ops@example.com', fullName: 'Ops', role: 'admin' });
    const calls = [
      () => as(s).put('/api/admin/settings/security', { sessionTimeout: 45 }),
      () => as(s).get('/api/admin/admins'),
      () => as(s).get(`/api/admin/admins/${created.body.data.admin.id}`),
      () => as(s).patch(`/api/admin/admins/${created.body.data.admin.id}`, { isActive: false }),
      () => as(s).post(`/api/admin/wallets/${wallet._id}/adjust`, { type: 'credit', amount: 50, reason: 'goodwill' }),
      () => as(s).get('/api/admin/wallets/adjustments'),
      () => as(s).get('/api/admin/wallets/reconciliation'),
    ];
    expect(created.status).toBe(201);
    expect(created).toSatisfyApiSpec();
    for (const call of calls) {
      const res = await call();
      expect(res.status).toBeLessThan(300);
      expect(res).toSatisfyApiSpec();
    }
  });

  it('failures carry the error envelope', async () => {
    const mod = await signIn(await createAdmin({ role: 'moderator' }));
    const forbidden = await as(mod).get('/api/admin/wallets/reconciliation');
    expect(forbidden.status).toBe(403);
    expect(forbidden).toSatisfyApiSpec();
    const s = await signIn(await createAdmin({ role: 'super_admin' }));
    const notFound = await as(s).get(`/api/admin/providers/${new mongoose.Types.ObjectId()}`);
    expect(notFound.status).toBe(404);
    expect(notFound).toSatisfyApiSpec();
    const invalid = await as(s).put('/api/admin/settings/security', { sessionTimeout: 1 });
    expect(invalid.status).toBe(400);
    expect(invalid).toSatisfyApiSpec();
    const unauth = await api().get('/api/admin/overview');
    expect(unauth.status).toBe(401);
    expect(unauth).toSatisfyApiSpec();
  });
});
