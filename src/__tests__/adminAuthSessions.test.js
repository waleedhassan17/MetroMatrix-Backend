/**
 * Phase B1 acceptance: admin sign-in, sessions, refresh rotation with reuse
 * detection, lockout, idle timeout, session restrictions, TOTP, and the
 * security/maintenance settings actually changing behaviour.
 *
 * Runs the real app (supertest) on the in-memory replica set. Only `Date` is
 * faked, so token expiry / lockout windows can be jumped over while the DB
 * driver's own timers stay real.
 */
const { connect, clear, disconnect } = require('../../test/helpers/db');
const { createAdmin, DEFAULT_PASSWORD } = require('../../test/helpers/factories');
const { api, signIn } = require('../../test/helpers/agent');
const AdminSettings = require('../models/AdminSettings');
const AdminAuditLog = require('../models/AdminAuditLog');
const AdminSession = require('../models/AdminSession');
const settingsCache = require('../services/settingsCache');
const totp = require('../services/admin/totp');

const REAL = [
  'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout',
];
const freezeClock = () => jest.useFakeTimers({ doNotFake: REAL, now: Date.now() });
const advance = (ms) => jest.setSystemTime(Date.now() + ms);
const MIN = 60 * 1000;

const setSecurity = async (patch) => {
  await AdminSettings.updateSettings('security', patch);
  settingsCache.invalidate();
};
const auditCount = (action) => AdminAuditLog.countDocuments({ action });
const profile = (bearer) => api().get('/api/admin/profile').set('Authorization', bearer);
const refresh = (refreshToken) => api().post('/api/admin/auth/refresh-token').send({ refreshToken });
const badLogin = (email) => api().post('/api/admin/auth/login').send({ email, password: 'not-the-password' });

beforeAll(connect);
afterEach(async () => {
  jest.useRealTimers();
  settingsCache.invalidate();
  await clear();
});
afterAll(disconnect);

describe('sign-in', () => {
  it('returns tokens whose expiry is read from the token itself (no hardcoded 86400)', async () => {
    const admin = await createAdmin({ role: 'super_admin' });
    const s = await signIn(admin);
    expect(s.accessToken).toEqual(expect.any(String));
    expect(s.refreshToken).toEqual(expect.any(String));
    expect(s.sessionId).toEqual(expect.any(String));
    expect(s.restrict).toBeNull();
    // JWT_EXPIRE defaults to 15m
    expect(s.expiresInSeconds).toBeGreaterThan(890);
    expect(s.expiresInSeconds).toBeLessThanOrEqual(900);
    expect(new Date(s.accessTokenExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(s.admin.permissions.canManageAdmins).toBe(true); // effective permissions for a super admin
    expect(await auditCount('admin.login.succeeded')).toBe(1);
  });

  it('answers a wrong password and an unknown email identically', async () => {
    const admin = await createAdmin();
    const wrong = await badLogin(admin.email);
    const unknown = await badLogin('nobody@example.com');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toEqual(unknown.body.error);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('only reveals deactivation after the password is proven', async () => {
    const admin = await createAdmin({ isActive: false });
    expect((await badLogin(admin.email)).body.error.code).toBe('INVALID_CREDENTIALS');
    const res = await api().post('/api/admin/auth/login').send({ email: admin.email, password: DEFAULT_PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DEACTIVATED');
  });

  it('the legacy /api/admin/login path runs the same chain', async () => {
    const admin = await createAdmin();
    const res = await api().post('/api/admin/login').send({ email: admin.email, password: DEFAULT_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.step).toBe('signed_in');
  });
});

describe('refresh and session lifetime', () => {
  it('keeps an admin signed in across 3+ access-token lifetimes', async () => {
    freezeClock();
    const admin = await createAdmin();
    let s = await signIn(admin);
    for (let i = 0; i < 4; i += 1) {
      expect((await profile(s.bearer())).status).toBe(200);
      advance(14 * MIN); // still active (idle timeout is 30 min)
      expect((await profile(s.bearer())).status).toBe(200);
      advance(2 * MIN); // access token (15 min) now expired
      expect((await profile(s.bearer())).status).toBe(401);
      const r = await refresh(s.refreshToken);
      expect(r.status).toBe(200);
      s = { ...r.body.data, bearer: () => `Bearer ${r.body.data.accessToken}` };
    }
    expect((await profile(s.bearer())).status).toBe(200);
  });

  it('refresh no longer requires a valid access token, and rotates the refresh token', async () => {
    const admin = await createAdmin();
    const s = await signIn(admin);
    const r = await refresh(s.refreshToken); // no Authorization header at all
    expect(r.status).toBe(200);
    expect(r.body.data.refreshToken).not.toBe(s.refreshToken);
    expect(r.body.data.sessionId).toBe(s.sessionId);
  });

  it('replaying a rotated refresh token revokes the session (reuse detection)', async () => {
    const admin = await createAdmin();
    const s = await signIn(admin);
    const first = await refresh(s.refreshToken);
    expect(first.status).toBe(200);

    const replay = await refresh(s.refreshToken);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('SESSION_REVOKED');

    // The legitimate holder is signed out too: both the newest refresh token
    // and the newest access token stop working.
    expect((await refresh(first.body.data.refreshToken)).status).toBe(401);
    const res = await profile(`Bearer ${first.body.data.accessToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_REVOKED');
    expect(await auditCount('admin.session.reuse_detected')).toBe(1);
  });

  it('a refresh token is never accepted as an access token', async () => {
    const admin = await createAdmin();
    const s = await signIn(admin);
    expect((await profile(`Bearer ${s.refreshToken}`)).status).toBe(401);
  });

  it('two devices hold independent sessions; logout ends only the current one', async () => {
    const admin = await createAdmin();
    const phone = await signIn(admin, { deviceLabel: 'phone' });
    const tablet = await signIn(admin, { deviceLabel: 'tablet' });

    const list = await api().get('/api/admin/sessions').set('Authorization', phone.bearer());
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.find((x) => x.current).deviceLabel).toBe('phone');
    expect(JSON.stringify(list.body.data)).not.toMatch(/refreshTokenHash/);

    expect((await api().post('/api/admin/auth/logout').set('Authorization', phone.bearer())).status).toBe(200);
    expect((await profile(phone.bearer())).status).toBe(401);
    expect((await profile(tablet.bearer())).status).toBe(200);
  });

  it('logout-all and revoking a session by id end those sessions', async () => {
    const admin = await createAdmin();
    const a = await signIn(admin);
    const b = await signIn(admin);
    const revoke = await api().delete(`/api/admin/sessions/${b.sessionId}`).set('Authorization', a.bearer());
    expect(revoke.status).toBe(200);
    expect((await profile(b.bearer())).status).toBe(401);

    const c = await signIn(admin);
    await api().post('/api/admin/auth/logout-all').set('Authorization', a.bearer());
    expect((await profile(a.bearer())).status).toBe(401);
    expect((await profile(c.bearer())).status).toBe(401);
  });

  it('changing the password signs out every other device', async () => {
    const admin = await createAdmin();
    const a = await signIn(admin);
    const b = await signIn(admin);
    const res = await api()
      .put('/api/admin/change-password')
      .set('Authorization', a.bearer())
      .send({ currentPassword: DEFAULT_PASSWORD, newPassword: 'A-Brand-New-Passphrase-7' });
    expect(res.status).toBe(200);
    expect(res.body.data.otherSessionsSignedOut).toBe(1);
    expect((await profile(a.bearer())).status).toBe(200);
    expect((await profile(b.bearer())).status).toBe(401);
    expect(await auditCount('admin.password.change')).toBe(1);
  });

  it('rejects weak new passwords with the reasons', async () => {
    const admin = await createAdmin();
    const s = await signIn(admin);
    const res = await api()
      .put('/api/admin/change-password')
      .set('Authorization', s.bearer())
      .send({ currentPassword: DEFAULT_PASSWORD, newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEAK_PASSWORD');
    expect(res.body.error.details.problems.length).toBeGreaterThan(0);
  });
});

describe('lockout (security.maxLoginAttempts / lockoutMinutes)', () => {
  it('locks the account after N failures — even the right password — and unlocks after the window', async () => {
    freezeClock();
    const admin = await createAdmin();
    for (let i = 0; i < 5; i += 1) expect((await badLogin(admin.email)).status).toBe(401);

    const locked = await api().post('/api/admin/auth/login').send({ email: admin.email, password: DEFAULT_PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(locked.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(locked.headers['retry-after']).toBeDefined();
    expect(await auditCount('admin.login.failed')).toBe(5);
    expect(await auditCount('admin.login.locked')).toBe(1);

    advance(16 * MIN);
    const after = await api().post('/api/admin/auth/login').send({ email: admin.email, password: DEFAULT_PASSWORD });
    expect(after.status).toBe(200);
  });

  it('changing maxLoginAttempts through the API changes when the lock happens', async () => {
    const boss = await createAdmin({ role: 'super_admin' });
    const s = await signIn(boss);
    const put = await api().put('/api/admin/settings/security').set('Authorization', s.bearer()).send({ maxLoginAttempts: 3 });
    expect(put.status).toBe(200);

    const target = await createAdmin();
    for (let i = 0; i < 3; i += 1) expect((await badLogin(target.email)).status).toBe(401);
    expect((await badLogin(target.email)).status).toBe(429);
  });

  // 20 sign-ins, each paying for a real bcrypt comparison (deliberately — it
  // equalises timing for unknown emails), need more than the 5 s default.
  it('also caps failures per address across different emails (20 by default)', async () => {
    for (let i = 0; i < 20; i += 1) await badLogin(`probe${i}@example.com`);
    const admin = await createAdmin();
    const res = await api().post('/api/admin/auth/login').send({ email: admin.email, password: DEFAULT_PASSWORD });
    expect(res.status).toBe(429);
  }, 30000);
});

describe('idle timeout (security.sessionTimeout)', () => {
  it('signs a session out after the configured inactivity, even with a valid access token', async () => {
    freezeClock();
    await setSecurity({ sessionTimeout: 5 });
    const admin = await createAdmin();
    const s = await signIn(admin);
    advance(6 * MIN); // access token (15 min) still valid; session idle 6 > 5
    const res = await profile(s.bearer());
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_IDLE_TIMEOUT');
    expect((await AdminSession.findById(s.sessionId)).revokedReason).toBe('idle_timeout');
  });

  it('activity keeps the session alive', async () => {
    freezeClock();
    await setSecurity({ sessionTimeout: 5 });
    const admin = await createAdmin();
    const s = await signIn(admin);
    for (let i = 0; i < 3; i += 1) {
      advance(4 * MIN);
      expect((await profile(s.bearer())).status).toBe(200);
    }
  });
});

describe('restricted sessions', () => {
  it('a temporary password restricts the session to changing it (mustChangePassword)', async () => {
    const admin = await createAdmin({ mustChangePassword: true });
    const s = await signIn(admin);
    expect(s.restrict).toBe('password_change');

    const blocked = await api().get('/api/admin/users').set('Authorization', s.bearer());
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await profile(s.bearer())).status).toBe(200);

    await api()
      .put('/api/admin/change-password')
      .set('Authorization', s.bearer())
      .send({ currentPassword: DEFAULT_PASSWORD, newPassword: 'A-Brand-New-Passphrase-7' });
    expect((await api().get('/api/admin/users').set('Authorization', s.bearer())).status).toBe(200);
  });

  it('security.passwordExpiry forces a change once the password is older than the limit', async () => {
    const admin = await createAdmin({ passwordChangedAt: new Date(Date.now() - 100 * 24 * 60 * MIN) });
    expect((await signIn(admin)).restrict).toBe('password_change');
    await setSecurity({ passwordExpiry: 0 }); // 0 = never
    expect((await signIn(admin)).restrict).toBeNull();
  });

  it('security.twoFactorEnabled restricts an un-enrolled super admin until 2FA is set up', async () => {
    await setSecurity({ twoFactorEnabled: true });
    const boss = await createAdmin({ role: 'super_admin' });
    const s = await signIn(boss);
    expect(s.restrict).toBe('totp_enrol');
    const blocked = await api().get('/api/admin/users').set('Authorization', s.bearer());
    expect(blocked.body.error.code).toBe('TOTP_ENROLMENT_REQUIRED');

    const enrol = await api().post('/api/admin/auth/2fa/enrol').set('Authorization', s.bearer()).send({ currentPassword: DEFAULT_PASSWORD });
    expect(enrol.status).toBe(200);
    const code = totp.totp(totp.base32Decode(enrol.body.data.secret));
    const verify = await api().post('/api/admin/auth/2fa/verify').set('Authorization', s.bearer()).send({ code });
    expect(verify.status).toBe(200);
    expect((await api().get('/api/admin/users').set('Authorization', s.bearer())).status).toBe(200);
  });

  it('the policy does not apply to admins who are not super admins', async () => {
    await setSecurity({ twoFactorEnabled: true });
    const admin = await createAdmin();
    expect((await signIn(admin)).restrict).toBeNull();
  });
});

describe('two-factor sign-in', () => {
  async function enrolledAdmin() {
    const admin = await createAdmin();
    const s = await signIn(admin);
    const enrol = await api().post('/api/admin/auth/2fa/enrol').set('Authorization', s.bearer()).send({ currentPassword: DEFAULT_PASSWORD });
    const raw = totp.base32Decode(enrol.body.data.secret);
    const verify = await api().post('/api/admin/auth/2fa/verify').set('Authorization', s.bearer()).send({ code: totp.totp(raw) });
    return { admin, raw, recoveryCodes: verify.body.data.recoveryCodes };
  }
  const loginStep = (admin) => api().post('/api/admin/auth/login').send({ email: admin.email, password: DEFAULT_PASSWORD });
  const totpStep = (body) => api().post('/api/admin/auth/login/totp').send(body);

  it('enrolment needs the current password', async () => {
    const admin = await createAdmin();
    const s = await signIn(admin);
    const res = await api().post('/api/admin/auth/2fa/enrol').set('Authorization', s.bearer()).send({ currentPassword: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('password alone no longer signs in; the code completes it, once', async () => {
    freezeClock();
    const { admin, raw } = await enrolledAdmin();
    advance(30 * 1000); // next time step (the enrolment code's step is used)

    const first = await loginStep(admin);
    expect(first.status).toBe(200);
    expect(first.body.data.step).toBe('totp_required');
    expect(first.body.data.accessToken).toBeUndefined();

    const wrong = await totpStep({ challengeToken: first.body.data.challengeToken, code: '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('TOTP_INVALID');

    const code = totp.totp(raw);
    const ok = await totpStep({ challengeToken: first.body.data.challengeToken, code });
    expect(ok.status).toBe(200);
    expect(ok.body.data.step).toBe('signed_in');

    // The same code can't be used again.
    const again = await loginStep(admin);
    expect((await totpStep({ challengeToken: again.body.data.challengeToken, code })).status).toBe(401);
  });

  it('a recovery code works exactly once', async () => {
    const { admin, recoveryCodes } = await enrolledAdmin();
    expect(recoveryCodes).toHaveLength(10);
    const one = await loginStep(admin);
    expect((await totpStep({ challengeToken: one.body.data.challengeToken, recoveryCode: recoveryCodes[0] })).status).toBe(200);
    const two = await loginStep(admin);
    expect((await totpStep({ challengeToken: two.body.data.challengeToken, recoveryCode: recoveryCodes[0] })).status).toBe(401);
    expect(await auditCount('admin.login.recovery_code_used')).toBe(1);
  });

  it('the challenge token is not an access token', async () => {
    const { admin } = await enrolledAdmin();
    const step = await loginStep(admin);
    expect((await profile(`Bearer ${step.body.data.challengeToken}`)).status).toBe(401);
  });
});

describe('maintenance mode (general.maintenanceMode)', () => {
  it('returns 503 to user/provider API traffic while admins and health checks keep working', async () => {
    const boss = await createAdmin({ role: 'super_admin' });
    const s = await signIn(boss);
    const on = await api()
      .put('/api/admin/settings/general')
      .set('Authorization', s.bearer())
      .send({ maintenanceMode: true, maintenanceMessage: 'Back at 6pm' });
    expect(on.status).toBe(200);

    const user = await api().get('/api/users/profile');
    expect(user.status).toBe(503);
    expect(user.body.message).toBe('Back at 6pm');
    expect(user.headers['retry-after']).toBeDefined();
    expect((await api().get('/health')).status).toBe(200);
    expect((await profile(s.bearer())).status).toBe(200);

    await api().put('/api/admin/settings/general').set('Authorization', s.bearer()).send({ maintenanceMode: false });
    expect((await api().get('/api/users/profile')).status).toBe(401); // back to normal: needs a token
  });
});

describe('settings writes', () => {
  it('validate values and reject unknown or removed settings', async () => {
    const boss = await createAdmin({ role: 'super_admin' });
    const s = await signIn(boss);
    const bad = await api().put('/api/admin/settings/security').set('Authorization', s.bearer()).send({ sessionTimeout: 1, ipWhitelist: [] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    expect(bad.body.error.details.fields.map((f) => f.field).sort()).toEqual(['ipWhitelist', 'sessionTimeout']);
  });

  it('security is super-admin only; general needs canManageSettings', async () => {
    const admin = await createAdmin({ permissions: { canManageSettings: false } });
    const s = await signIn(admin);
    const sec = await api().put('/api/admin/settings/security').set('Authorization', s.bearer()).send({ sessionTimeout: 60 });
    expect(sec.status).toBe(403);
    expect(sec.body.error.code).toBe('SUPER_ADMIN_REQUIRED');
    const gen = await api().put('/api/admin/settings/general').set('Authorization', s.bearer()).send({ platformName: 'X' });
    expect(gen.status).toBe(403);
    expect(gen.body.error.code).toBe('FORBIDDEN');
  });

  it('GET returns the values plus the spec the app renders controls from, and writes are audited', async () => {
    const boss = await createAdmin({ role: 'super_admin' });
    const s = await signIn(boss);
    await api().put('/api/admin/settings/security').set('Authorization', s.bearer()).send({ sessionTimeout: 45 });
    const res = await api().get('/api/admin/settings').set('Authorization', s.bearer());
    expect(res.status).toBe(200);
    expect(res.body.data.values.security.sessionTimeout).toBe(45);
    expect(res.body.data.spec.security.fields.sessionTimeout).toMatchObject({ type: 'integer', min: 5, max: 1440, unit: 'minutes' });
    expect(res.body.data.values.appearance).toBeUndefined();
    const row = await AdminAuditLog.findOne({ action: 'settings.security.update' }).lean();
    expect(row.before).toEqual({ sessionTimeout: 30 });
    expect(row.after).toEqual({ sessionTimeout: 45 });
  });
});
