/**
 * Refresh sessions for user and provider accounts (src/services/refreshSessions.js).
 *
 * The account used to hold ONE refresh token, so a second client always broke
 * the first: the phone and the web app signed each other out, and two browser
 * tabs refreshing together lost the race and wiped the session from both.
 * These run the real routes on the in-memory replica set. Only `Date` is
 * faked, so the reuse grace window can be jumped over.
 */
const crypto = require('crypto');
const { connect, clear, disconnect } = require('../../../test/helpers/db');
const { createUser, createProvider, DEFAULT_PASSWORD } = require('../../../test/helpers/factories');
const { api } = require('../../../test/helpers/agent');
const User = require('../../models/User');
const { generateTokens } = require('../../utils/generateToken');
const { endAllRefreshSessions } = require('../refreshSessions');

const REAL = [
  'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout',
];
const freezeClock = () => jest.useFakeTimers({ doNotFake: REAL, now: Date.now() });
const advance = (ms) => jest.setSystemTime(Date.now() + ms);
const PAST_GRACE = 61 * 1000;

const signIn = async (account, path = '/api/auth/login') => {
  const res = await api().post(path).send({ email: account.email, password: DEFAULT_PASSWORD });
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { access: res.body.accessToken, refresh: res.body.refreshToken };
};
const refresh = (refreshToken) => api().post('/api/auth/refresh').send({ refreshToken });
const logout = (session, body) => {
  const req = api().post('/api/auth/logout').set('Authorization', `Bearer ${session.access}`);
  return body ? req.send(body) : req.send();
};
const sessionsOf = async (id) => (await User.findById(id).select('+refreshSessions').lean()).refreshSessions || [];

beforeAll(connect);
afterEach(async () => {
  jest.useRealTimers();
  delete process.env.REFRESH_SESSION_LIMIT;
  await clear();
});
afterAll(disconnect);

describe('refresh sessions', () => {
  it('lets the phone and the browser on one account each keep renewing', async () => {
    const user = await createUser();
    const phone = await signIn(user);
    const browser = await signIn(user);

    const phone2 = await refresh(phone.refresh);
    const browser2 = await refresh(browser.refresh);
    expect(phone2.status).toBe(200);
    expect(browser2.status).toBe(200);

    // And again with the rotated tokens: neither rotation disturbed the other.
    expect((await refresh(phone2.body.refreshToken)).status).toBe(200);
    expect((await refresh(browser2.body.refreshToken)).status).toBe(200);
  });

  it('lets two browser tabs refresh the same token at the same moment', async () => {
    const user = await createUser();
    const { refresh: shared } = await signIn(user);

    const [tabA, tabB] = await Promise.all([refresh(shared), refresh(shared)]);
    expect(tabA.status).toBe(200);
    expect(tabB.status).toBe(200);
    expect(tabA.body.refreshToken).not.toBe(tabB.body.refreshToken);

    // Whichever one the shared storage ends up holding keeps working.
    expect((await refresh(tabA.body.refreshToken)).status).toBe(200);
    expect((await refresh(tabB.body.refreshToken)).status).toBe(200);
  });

  it('refuses a rotated token once the grace window has passed', async () => {
    freezeClock();
    const user = await createUser();
    const { refresh: first } = await signIn(user);
    const rotated = await refresh(first);
    expect(rotated.status).toBe(200);

    advance(PAST_GRACE);
    expect((await refresh(first)).status).toBe(401);
    // The legitimate holder is unaffected.
    expect((await refresh(rotated.body.refreshToken)).status).toBe(200);
  });

  it('signs out only the client that names its refresh token', async () => {
    const user = await createUser();
    const phone = await signIn(user);
    const browser = await signIn(user);

    expect((await logout(browser, { refreshToken: browser.refresh })).status).toBe(200);
    expect((await refresh(browser.refresh)).status).toBe(401);
    expect((await refresh(phone.refresh)).status).toBe(200);
  });

  it('ends every session on a bare logout, as apps built before sessions expect', async () => {
    const user = await createUser();
    const phone = await signIn(user);
    const browser = await signIn(user);

    expect((await logout(browser)).status).toBe(200);
    expect((await refresh(browser.refresh)).status).toBe(401);
    expect((await refresh(phone.refresh)).status).toBe(401);
  });

  it('ends every session on endAllRefreshSessions (password reset, deactivation)', async () => {
    const user = await createUser();
    const phone = await signIn(user);
    const browser = await signIn(user);

    await endAllRefreshSessions(user);
    expect((await refresh(phone.refresh)).status).toBe(401);
    expect((await refresh(browser.refresh)).status).toBe(401);
  });

  it('honours a token issued before sessions existed exactly once, then migrates it', async () => {
    freezeClock();
    const user = await createUser();
    const legacy = generateTokens(user._id, { userType: 'user', email: user.email }).refreshToken;
    await User.updateOne({ _id: user._id }, { $set: { refreshToken: legacy } });

    const migrated = await refresh(legacy);
    expect(migrated.status).toBe(200);
    expect((await User.findById(user._id).lean()).refreshToken).toBeUndefined();

    advance(PAST_GRACE);
    expect((await refresh(legacy)).status).toBe(401);
    expect((await refresh(migrated.body.refreshToken)).status).toBe(200);
  });

  it('drops the least recently used session past the cap, not the oldest', async () => {
    process.env.REFRESH_SESSION_LIMIT = '3';
    const user = await createUser();
    const phone = await signIn(user);
    const stale = await signIn(user);
    // The phone renews, so it is now more recently used than `stale`.
    const phoneNow = await refresh(phone.refresh);
    expect(phoneNow.status).toBe(200);
    await signIn(user);
    await signIn(user);

    expect(await sessionsOf(user._id)).toHaveLength(3);
    expect((await refresh(stale.refresh)).status).toBe(401);
    expect((await refresh(phoneNow.body.refreshToken)).status).toBe(200);
  });

  it('stores only hashes, and never returns sessions in a response', async () => {
    const user = await createUser();
    const { access, refresh: token } = await signIn(user);

    const [session] = await sessionsOf(user._id);
    expect(session.hash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(await sessionsOf(user._id))).not.toContain(token);

    const profile = await api().get('/api/users/profile').set('Authorization', `Bearer ${access}`);
    expect(profile.status).toBe(200);
    expect(JSON.stringify(profile.body)).not.toMatch(/refreshSessions|refreshToken/);
  });

  it('gives providers the same per-client sessions', async () => {
    const provider = await createProvider({ emailVerified: 'active', adminVerified: 'active' });
    const phone = await signIn(provider, '/api/auth/provider/login');
    const browser = await signIn(provider, '/api/auth/provider/login');

    const phone2 = await refresh(phone.refresh);
    expect(phone2.status).toBe(200);
    expect(phone2.body.userType).toBe('provider');
    expect((await refresh(browser.refresh)).status).toBe(200);
  });
});
