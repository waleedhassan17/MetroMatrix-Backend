/**
 * Every guarded admin route refuses callers without the permission — driven
 * by the live route table, so a new route is covered the moment it exists:
 *  - an admin holding no permissions gets 403 on every route guarded by
 *    requirePermission(…) / requireSuperAdmin (QA Q07);
 *  - a signed-in customer gets 401/403 on every non-public admin route (Q09).
 */
const mongoose = require('mongoose');
const { connect, clear, disconnect } = require('../../test/helpers/db');
const { createAdmin, createUser } = require('../../test/helpers/factories');
const { app, api, signIn } = require('../../test/helpers/agent');
const { routeTable } = require('../utils/routeTable');
const { generateAccessToken } = require('../utils/generateToken');
const { PERMISSION_KEYS } = require('../config/adminRoles');

const ADMIN_PREFIX = /^\/api\/(admin|v1\/admin|shopping\/admin)(\/|$)/;
const PUBLIC = new Set([
  'POST /api/admin/auth/login',
  'POST /api/admin/login',
  'POST /api/admin/auth/login/totp',
  'POST /api/admin/auth/refresh-token',
  'POST /api/admin/provider-submissions',
  'GET /api/admin/provider-submissions/check-status',
]);
const isPermissionGuard = (m) => /^requirePermission\(/.test(m) || m === 'requireSuperAdmin';
const fill = (p) => p.replace(/\([^)]*\)/g, '').replace(/:\w+/g, () => new mongoose.Types.ObjectId().toString());
const call = (method, path, bearer) => api()[method.toLowerCase()](path).set('Authorization', bearer).send({});

const routes = routeTable(app).filter((r) => ADMIN_PREFIX.test(r.path) && !PUBLIC.has(`${r.method} ${r.path}`));
const guarded = routes.filter((r) => r.middleware.some(isPermissionGuard));

beforeAll(connect);
afterAll(async () => {
  await clear();
  await disconnect();
});

it('covers the guarded surface', () => {
  expect(guarded.length).toBeGreaterThan(90);
});

it('an admin with no permissions is refused (403) on every guarded route', async () => {
  const none = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false]));
  const s = await signIn(await createAdmin({ role: 'admin', permissions: none }));
  const wrong = [];
  for (const r of guarded) {
    const res = await call(r.method, fill(r.path), s.bearer());
    if (res.status !== 403) wrong.push(`${r.method} ${r.path} → ${res.status}`);
  }
  expect(wrong).toEqual([]);
}, 120000);

it('a customer token never gets into the admin API (401/403)', async () => {
  const user = await createUser();
  const bearer = `Bearer ${generateAccessToken(user._id, { userType: 'user' })}`;
  const wrong = [];
  for (const r of routes) {
    const res = await call(r.method, fill(r.path), bearer);
    if (![401, 403].includes(res.status)) wrong.push(`${r.method} ${r.path} → ${res.status}`);
  }
  expect(wrong).toEqual([]);
}, 120000);
