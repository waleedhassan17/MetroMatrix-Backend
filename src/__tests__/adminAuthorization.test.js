/**
 * Phase B2 acceptance — permissions are enforced on the server and admin
 * management follows its rules:
 *  - a moderator with the default flags gets 403 on refunds, dispute
 *    decisions, payout decisions, wallet adjustments, settings writes and
 *    admin management (QA matrix Q07);
 *  - an admin who HAS the permission gets past the guard (404 on a made-up
 *    id, not 403);
 *  - super-admin-only rules, self-modification, last super admin (Q08);
 *  - every mutation writes exactly one audit row.
 */
const mongoose = require('mongoose');
const { connect, clear, disconnect } = require('../../test/helpers/db');
const { createAdmin, createModerator, DEFAULT_PASSWORD } = require('../../test/helpers/factories');
const { api, signIn } = require('../../test/helpers/agent');
const Admin = require('../models/Admin');
const AdminAuditLog = require('../models/AdminAuditLog');
const { ROLE_PRESETS, PERMISSION_KEYS } = require('../config/adminRoles');

const anyId = () => new mongoose.Types.ObjectId().toString();
const call = (bearer, method, path, body) => api()[method](path).set('Authorization', bearer).send(body || {});

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

describe('permission flags', () => {
  it('the role presets and the Admin schema define the same flags', () => {
    expect([...Admin.PERMISSION_KEYS].sort()).toEqual([...PERMISSION_KEYS].sort());
    for (const preset of Object.values(ROLE_PRESETS)) expect(Object.keys(preset).sort()).toEqual([...PERMISSION_KEYS].sort());
  });

  it('role decides isSuperAdmin, whatever is passed', async () => {
    const a = await createAdmin({ role: 'admin', isSuperAdmin: true });
    expect(a.isSuperAdmin).toBe(false);
    const b = await createAdmin({ role: 'super_admin', isSuperAdmin: false });
    expect(b.isSuperAdmin).toBe(true);
  });
});

describe('a moderator with default permissions (Q07)', () => {
  const FORBIDDEN = [
    ['post', '/api/admin/bookings/:id/refund', { reason: 'x' }],
    ['patch', '/api/admin/disputes/:id', { status: 'resolved' }],
    ['patch', '/api/admin/payout-requests/:id', { action: 'approve' }],
    ['post', '/api/admin/wallets/:id/adjust', { type: 'credit', amount: 10, reason: 'x' }],
    ['put', '/api/admin/settings/general', { platformName: 'X' }],
    ['put', '/api/admin/settings/security', { sessionTimeout: 60 }],
    ['put', '/api/admin/settings/finance', { adjustmentApprovalThreshold: 1 }],
    ['get', '/api/admin/admins'],
    ['post', '/api/admin/admins', { email: 'x@example.com', fullName: 'X', role: 'admin' }],
    ['post', '/api/v1/admin/appointments/:id/refund', { reason: 'x' }],
    ['post', '/api/shopping/admin/orders/:id/refund', { reason: 'x' }],
    ['get', '/api/admin/wallets/reconciliation'],
    ['get', '/api/admin/bookings'],
  ];

  it.each(FORBIDDEN.map(([m, p, b]) => [m.toUpperCase(), p, b]))('%s %s → 403', async (method, path, body) => {
    const mod = await createModerator();
    const s = await signIn(mod);
    const res = await call(s.bearer(), method.toLowerCase(), path.replace(':id', anyId()), body);
    expect(res.status).toBe(403);
    expect(['FORBIDDEN', 'SUPER_ADMIN_REQUIRED']).toContain(res.body.error.code);
  });

  it('nothing it was refused left an audit row', async () => {
    const mod = await createModerator();
    const s = await signIn(mod);
    await call(s.bearer(), 'post', `/api/admin/wallets/${anyId()}/adjust`, { type: 'credit', amount: 10, reason: 'x' });
    expect(await AdminAuditLog.countDocuments({ actor: mod._id, action: { $not: /^admin\.login/ } })).toBe(0);
  });
});

describe('an admin holding the permission passes the guard', () => {
  // Every row has all four values: with fewer, jest would pass its `done`
  // callback as `body` and wait for it.
  it.each([
    ['canManageFinance', 'post', '/api/admin/wallets/:id/adjust', { type: 'credit', amount: 10, reason: 'x' }],
    ['canManageHomeServices', 'get', '/api/admin/bookings/:id', null],
    ['canManageUsers', 'get', '/api/admin/users/:id', null],
  ])('%s', async (flag, method, path, body) => {
    const admin = await createAdmin({ permissions: { [flag]: true } });
    const s = await signIn(admin);
    const res = await call(s.bearer(), method, path.replace(':id', anyId()), body);
    expect(res.status).toBe(404);
  });
});

describe('admin management (Q08)', () => {
  it('a super admin creates an admin with a one-time temporary password; their first session must change it', async () => {
    const boss = await createAdmin({ role: 'super_admin' });
    const s = await signIn(boss);
    const res = await call(s.bearer(), 'post', '/api/admin/admins', { email: 'New.Ops@Example.com', fullName: 'New Ops', role: 'moderator' });
    expect(res.status).toBe(201);
    const { admin, temporaryPassword } = res.body.data;
    expect(admin.email).toBe('new.ops@example.com');
    expect(admin.role).toBe('moderator');
    expect(admin.permissions).toEqual(ROLE_PRESETS.moderator);
    expect(temporaryPassword.length).toBeGreaterThanOrEqual(16);

    const first = await api().post('/api/admin/auth/login').send({ email: admin.email, password: temporaryPassword });
    expect(first.body.data.restrict).toBe('password_change');

    // The password never reaches the audit trail.
    const row = await AdminAuditLog.findOne({ action: 'admin.create' }).lean();
    expect(JSON.stringify(row)).not.toContain(temporaryPassword);
  });

  it('only a super admin can create admins or change roles and permissions', async () => {
    const manager = await createAdmin({ permissions: { canManageAdmins: true } });
    const target = await createAdmin();
    const s = await signIn(manager);
    expect((await call(s.bearer(), 'post', '/api/admin/admins', { email: 'a@b.co', fullName: 'A', role: 'admin' })).status).toBe(403);
    const role = await call(s.bearer(), 'patch', `/api/admin/admins/${target._id}`, { role: 'moderator' });
    expect(role.status).toBe(403);
    expect(role.body.error.code).toBe('SUPER_ADMIN_REQUIRED');
    // …but can disable a regular admin.
    expect((await call(s.bearer(), 'patch', `/api/admin/admins/${target._id}`, { isActive: false })).status).toBe(200);
  });

  it('nobody changes their own role, permissions or active state', async () => {
    const boss = await createAdmin({ role: 'super_admin' });
    await createAdmin({ role: 'super_admin' });
    const s = await signIn(boss);
    const res = await call(s.bearer(), 'patch', `/api/admin/admins/${boss._id}`, { role: 'admin' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SELF_MODIFICATION');
  });

  it('the last active super admin cannot be demoted or disabled', async () => {
    const boss = await createAdmin({ role: 'super_admin' });
    const peer = await createAdmin({ role: 'super_admin' });
    const s = await signIn(boss);

    // Two super admins: demoting one is fine.
    expect((await call(s.bearer(), 'patch', `/api/admin/admins/${peer._id}`, { role: 'admin' })).status).toBe(200);

    // Now `boss` is the last one. They can't demote or disable themselves…
    const self = await call(s.bearer(), 'patch', `/api/admin/admins/${boss._id}`, { isActive: false });
    expect(self.body.error.code).toBe('SELF_MODIFICATION');
    // …and an admin manager who isn't a super admin can't touch a super admin.
    const manager = await createAdmin({ permissions: { canManageAdmins: true } });
    const m = await signIn(manager);
    const denied = await call(m.bearer(), 'patch', `/api/admin/admins/${boss._id}`, { isActive: false });
    expect(denied.body.error.code).toBe('SUPER_ADMIN_REQUIRED');

    // The guard behind both (for any other path that might try).
    const { assertNotLastSuperAdmin } = require('../controllers/admin/admins');
    await expect(assertNotLastSuperAdmin(boss)).rejects.toMatchObject({ code: 'LAST_SUPER_ADMIN' });
    expect(await Admin.countDocuments({ role: 'super_admin', isActive: true })).toBe(1);
  });

  it('disabling an admin signs them out everywhere at once', async () => {
    const boss = await createAdmin({ role: 'super_admin' });
    const target = await createAdmin();
    const s = await signIn(boss);
    const t = await signIn(target);
    const res = await call(s.bearer(), 'patch', `/api/admin/admins/${target._id}`, { isActive: false, reason: 'left the team' });
    expect(res.body.data.sessionsSignedOut).toBe(1);
    expect((await api().get('/api/admin/profile').set('Authorization', t.bearer())).status).toBe(401);
    const row = await AdminAuditLog.findOne({ action: 'admin.update', targetId: target._id }).lean();
    expect(row.before).toEqual({ isActive: true });
    expect(row.after).toEqual({ isActive: false });
    expect(row.reason).toBe('left the team');
  });

  it('a password reset issues a temporary password and ends the target’s sessions', async () => {
    const boss = await createAdmin({ role: 'super_admin' });
    const target = await createAdmin();
    const s = await signIn(boss);
    const t = await signIn(target);
    const res = await call(s.bearer(), 'post', `/api/admin/admins/${target._id}/reset-password`);
    expect(res.status).toBe(200);
    expect((await api().get('/api/admin/profile').set('Authorization', t.bearer())).status).toBe(401);
    const old = await api().post('/api/admin/auth/login').send({ email: target.email, password: DEFAULT_PASSWORD });
    expect(old.status).toBe(401);
    const fresh = await api().post('/api/admin/auth/login').send({ email: target.email, password: res.body.data.temporaryPassword });
    expect(fresh.body.data.restrict).toBe('password_change');
  });
});
