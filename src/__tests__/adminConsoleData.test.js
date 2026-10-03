/**
 * Phase B3 acceptance — the data behind the console is correct and in one
 * shape:
 *  - month windows are Asia/Karachi, growth is null without a baseline (Q12);
 *  - GET /meta serves every list from the schemas;
 *  - GET /overview: honest zeros on an empty DB (Q10), a failing module comes
 *    back `unavailable` while the rest renders (Q11), permission-filtered,
 *    fast on a realistic dataset;
 *  - GET /queue: oldest first across types, stable cursor, only work the
 *    admin may do;
 *  - provider states (suspended ≠ rejected), list filters and paging clamps;
 *  - notifications are per admin;
 *  - every admin response uses one envelope.
 */
const mongoose = require('mongoose');
const { connect, clear, disconnect } = require('../../test/helpers/db');
const { createAdmin, createProvider, createUser } = require('../../test/helpers/factories');
const { api, signIn } = require('../../test/helpers/agent');
const { eventually } = require('../../test/helpers/eventually');
const { monthWindows, growthPct } = require('../utils/time');
const Provider = require('../models/Provider');
const User = require('../models/User');
const Notification = require('../models/Notification');
const AdminAuditLog = require('../models/AdminAuditLog');
const Booking = require('../modules/homeservice/models/Booking');
const Dispute = require('../modules/homeservice/models/Dispute');
const PayoutRequest = require('../modules/homeservice/models/PayoutRequest');
const { VERTICALS } = require('../services/admin/overviewService');
const notifications = require('../services/notificationService');

const get = (s, path) => api().get(path).set('Authorization', s.bearer());
const put = (s, path, body) => api().put(path).set('Authorization', s.bearer()).send(body || {});
const submitted = (overrides) =>
  createProvider({ submittedAt: new Date(), status: 'pending_review', verificationStatus: 'pending', ...overrides });

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

describe('time windows (Asia/Karachi)', () => {
  it('a month starts at 00:00 Pakistan time, i.e. 19:00 UTC the day before', () => {
    const w = monthWindows(new Date('2026-03-15T10:00:00Z'));
    expect(w.thisMonth.from.toISOString()).toBe('2026-02-28T19:00:00.000Z');
    expect(w.lastMonth.from.toISOString()).toBe('2026-01-31T19:00:00.000Z');
    expect(w.lastMonth.to.toISOString()).toBe('2026-02-28T19:00:00.000Z');
  });

  it('crosses the year boundary, and the same-period window is capped at month end', () => {
    // 1 Jan 03:00 PKT is still 31 Dec in UTC.
    const jan = monthWindows(new Date('2025-12-31T22:00:00Z'));
    expect(jan.thisMonth.from.toISOString()).toBe('2025-12-31T19:00:00.000Z');
    expect(jan.lastMonth.from.toISOString()).toBe('2025-11-30T19:00:00.000Z');
    // 31 March vs February (28 days): the comparison window stops at the end of Feb.
    const mar31 = monthWindows(new Date('2026-03-31T12:00:00Z'));
    expect(mar31.samePeriodLastMonth.to.getTime()).toBe(mar31.lastMonth.to.getTime());
  });

  it('growth is null without a baseline, never 0 or an invented trend', () => {
    expect(growthPct(5, 0)).toBeNull();
    expect(growthPct(0, 0)).toBeNull();
    expect(growthPct(15, 10)).toBe(50);
    expect(growthPct(5, 10)).toBe(-50);
  });
});

describe('GET /api/admin/meta', () => {
  it('serves statuses from the schemas with labels and tones, plus limits and the viewer', async () => {
    await submitted({ city: 'Lahore' });
    const s = await signIn(await createAdmin({ role: 'super_admin' }));
    const res = await get(s, '/api/admin/meta');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.currency).toBe('PKR');
    expect(d.timezone).toBe('Asia/Karachi');
    expect(d.limits.maxPageSize).toBe(100);
    expect(d.viewer.permissions.canManageFinance).toBe(true);
    expect(d.enums.providerStates.map((x) => x.value)).toEqual(['incomplete', 'pending', 'approved', 'rejected', 'suspended']);
    expect(d.enums.bookingStatuses.find((x) => x.value === 'COMPLETED')).toMatchObject({ label: 'Completed', tone: 'success' });
    expect(d.enums.providerTypes.map((x) => x.value)).not.toContain('pending');
    expect(d.roles.map((r) => r.value)).toEqual(['super_admin', 'admin', 'moderator']);
    expect(d.cities).toContain('Lahore');
    expect(d.featureFlags.auditLog).toBe(false);
  });
});

describe('GET /api/admin/overview', () => {
  it('on an empty database: honest zeros, null growth, no invented numbers (Q10)', async () => {
    const s = await signIn(await createAdmin({ role: 'super_admin' }));
    const res = await get(s, '/api/admin/overview');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, max-age=30');
    const d = res.body.data;
    const kpi = Object.fromEntries(d.kpis.map((k) => [k.key, k]));
    expect(kpi.users_total.value).toBe(0);
    expect(kpi.users_new.delta).toBeNull();
    expect(kpi.providers_new.delta).toBeNull();
    expect(d.queues.every((q) => q.count === 0)).toBe(true);
    expect(d.verticals.homeservice.status).toBe('ok');
    expect(d.verticals.healthcare.headline.find((m) => m.key === 'cancellation_rate').value).toBeNull();
  });

  it('a failing module comes back unavailable; everything else still renders (Q11)', async () => {
    const original = VERTICALS.shopping.load;
    VERTICALS.shopping.load = () => Promise.reject(new Error('shopping is down'));
    try {
      const s = await signIn(await createAdmin({ role: 'super_admin' }));
      const res = await get(s, '/api/admin/overview');
      expect(res.status).toBe(200);
      expect(res.body.data.verticals.shopping).toMatchObject({ status: 'unavailable', headline: [] });
      expect(res.body.data.verticals.homeservice.status).toBe('ok');
      expect(res.body.data.kpis.length).toBeGreaterThan(0);
    } finally {
      VERTICALS.shopping.load = original;
    }
  });

  it('only shows the queues and modules the admin may act on', async () => {
    const mod = await createAdmin({ role: 'moderator', permissions: { canApproveProviders: true } });
    const res = await get(await signIn(mod), '/api/admin/overview');
    expect(res.body.data.queues.map((q) => q.type)).toEqual(['provider_approval']);
    expect(Object.keys(res.body.data.verticals)).toEqual([]);
  });

  it('counts this month vs the same stretch of last month', async () => {
    const now = new Date();
    const w = monthWindows(now);
    const inLastWindow = new Date(w.samePeriodLastMonth.from.getTime() + 1000);
    await User.collection.insertMany([
      { email: 'a@x.co', fullName: 'A', createdAt: now },
      { email: 'b@x.co', fullName: 'B', createdAt: now },
      { email: 'c@x.co', fullName: 'C', createdAt: inLastWindow },
    ]);
    const s = await signIn(await createAdmin({ role: 'super_admin' }));
    const kpi = Object.fromEntries((await get(s, '/api/admin/overview')).body.data.kpis.map((k) => [k.key, k]));
    expect(kpi.users_new.value).toBe(2);
    expect(kpi.users_new.delta).toBe(100);
  });

  it('answers in under 800 ms on a realistic dataset', async () => {
    const t0 = new Date();
    const users = Array.from({ length: 5000 }, (_, i) => ({ email: `u${i}@x.co`, fullName: `U${i}`, createdAt: t0 }));
    const providers = Array.from({ length: 1000 }, (_, i) => ({
      email: `p${i}@x.co`,
      fullName: `P${i}`,
      providerType: 'home_service',
      verificationStatus: i % 3 ? 'approved' : 'pending',
      submittedAt: t0,
      createdAt: t0,
    }));
    await User.collection.insertMany(users);
    const ins = await Provider.collection.insertMany(providers);
    const pIds = Object.values(ins.insertedIds);
    await Booking.collection.insertMany(
      Array.from({ length: 5000 }, (_, i) => ({
        customer: new mongoose.Types.ObjectId(),
        provider: pIds[i % pIds.length],
        serviceCategory: 'electricians',
        scheduledFor: t0,
        address: { line1: 'x' },
        status: 'COMPLETED',
        payment: { status: 'paid', paidAt: t0, requestedAmount: 1000 },
        createdAt: t0,
      }))
    );
    await Promise.all([User.createIndexes(), Provider.createIndexes(), Booking.createIndexes()]);
    const s = await signIn(await createAdmin({ role: 'super_admin' }));
    await get(s, '/api/admin/overview'); // warm-up
    const started = Date.now();
    const res = await get(s, '/api/admin/overview');
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect(res.body.data.verticals.homeservice.headline.find((m) => m.key === 'gmv_today').value).toBe(5000000);
    expect(elapsed).toBeLessThan(800);
  }, 60000);
});

describe('GET /api/admin/queue', () => {
  it('lists work oldest first across types, pages with a stable cursor, and hides what the admin may not do', async () => {
    const day = (n) => new Date(Date.UTC(2026, 0, n));
    await submitted({ submittedAt: day(3) });
    await submitted({ submittedAt: day(1) });
    const booking = new mongoose.Types.ObjectId();
    await Dispute.collection.insertOne({ booking, raisedBy: { id: booking, role: 'customer' }, role: 'customer', againstRole: 'provider', reason: 'No show', status: 'open', createdAt: day(2) });
    await PayoutRequest.collection.insertOne({ provider: new mongoose.Types.ObjectId(), amount: 900, status: 'pending', createdAt: day(4) });

    const boss = await signIn(await createAdmin({ role: 'super_admin' }));
    const first = await get(boss, '/api/admin/queue?limit=2');
    expect(first.body.data.map((i) => i.type)).toEqual(['provider_approval', 'dispute']);
    expect(first.body.meta.nextCursor).toEqual(expect.any(String));
    const second = await get(boss, `/api/admin/queue?limit=2&cursor=${first.body.meta.nextCursor}`);
    expect(second.body.data.map((i) => i.type)).toEqual(['provider_approval', 'payout_request']);
    expect(second.body.data[1].amount).toEqual({ value: 900, currency: 'PKR' });
    const ids = [...first.body.data, ...second.body.data].map((i) => i.id);
    expect(new Set(ids).size).toBe(4);

    const reviewer = await signIn(await createAdmin({ role: 'moderator', permissions: { canApproveProviders: true } }));
    const mine = await get(reviewer, '/api/admin/queue');
    expect(new Set(mine.body.data.map((i) => i.type))).toEqual(new Set(['provider_approval']));
    expect((await get(reviewer, '/api/admin/queue?type=bogus')).status).toBe(400);
  });
});

describe('providers', () => {
  let s;
  beforeEach(async () => {
    s = await signIn(await createAdmin({ permissions: { canApproveProviders: true } }));
  });

  it('suspending an approved provider makes them suspended — not rejected — and signs them out', async () => {
    const p = await submitted();
    expect((await put(s, `/api/admin/providers/${p._id}/approve`)).body.data.state).toBe('approved');
    const res = await put(s, `/api/admin/providers/${p._id}/suspend`, { reason: 'Complaints under review' });
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe('suspended');
    expect(res.body.data.history.map((h) => h.action)).toEqual(['provider.suspend', 'provider.approve']);
    const stored = await Provider.findById(p._id);
    expect(stored.verificationStatus).toBe('approved');
    expect(stored.adminVerified).toBe('inactive'); // provider login refuses
    expect(stored.isActive).toBe(false); // protect refuses on the next request

    const list = await get(s, '/api/admin/providers');
    expect(list.body.meta.counts).toMatchObject({ suspended: 1, rejected: 0 });
    expect((await put(s, `/api/admin/providers/${p._id}/unsuspend`)).body.data.state).toBe('approved');
    expect((await Provider.findById(p._id)).adminVerified).toBe('active');
  });

  it('suspend and reject require a reason', async () => {
    const p = await submitted();
    expect((await put(s, `/api/admin/providers/${p._id}/reject`, {})).status).toBe(400);
    expect((await put(s, `/api/admin/providers/${p._id}/suspend`, {})).status).toBe(400);
  });

  it('the pending queue only holds submitted applications', async () => {
    await createProvider(); // signed up, never submitted
    await submitted();
    const res = await get(s, '/api/admin/providers?state=pending');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.counts).toMatchObject({ incomplete: 1, pending: 1 });
  });

  it('clamps the page size and ignores unknown sort fields', async () => {
    await Provider.collection.insertMany(
      Array.from({ length: 120 }, (_, i) => ({ email: `p${i}@x.co`, fullName: `P${i}`, providerType: 'vendor', createdAt: new Date() }))
    );
    const res = await get(s, '/api/admin/providers?limit=100000&sort=password');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(100);
    expect(res.body.meta).toMatchObject({ limit: 100, total: 120, pages: 2 });
    const zero = await get(s, '/api/admin/providers?limit=0');
    expect(zero.body.data).toHaveLength(1);
  });

  it('cursor paging walks the whole list without repeats', async () => {
    await Provider.collection.insertMany(
      Array.from({ length: 25 }, (_, i) => ({ email: `p${i}@x.co`, fullName: `P${i}`, providerType: 'vendor', createdAt: new Date(2026, 0, 1 + (i % 5)) }))
    );
    const seen = [];
    let cursor = '';
    for (let i = 0; i < 5; i += 1) {
      const res = await get(s, `/api/admin/providers?limit=10${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...res.body.data.map((p) => p.id));
      if (!res.body.meta.nextCursor) break;
      cursor = res.body.meta.nextCursor;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });
});

describe('notifications are per admin', () => {
  it('reading or dismissing affects only the caller, and admins only see their kind of work', async () => {
    const a = await createAdmin({ permissions: { canManageFinance: true } });
    const b = await createAdmin({ permissions: { canManageFinance: true } });
    const c = await createAdmin({ permissions: { canManageFinance: false } });
    const n = await notifications.notifyPayoutRequested({ _id: new mongoose.Types.ObjectId(), amount: 500 }, 'Ali');
    const [sa, sb, sc] = [await signIn(a), await signIn(b), await signIn(c)];

    expect((await get(sa, '/api/admin/notifications/unread-count')).body.data.unread).toBe(1);
    expect((await get(sc, '/api/admin/notifications')).body.data).toHaveLength(0); // no finance permission

    await put(sa, `/api/admin/notifications/${n._id}/read`);
    expect((await get(sa, '/api/admin/notifications/unread-count')).body.data.unread).toBe(0);
    expect((await get(sb, '/api/admin/notifications/unread-count')).body.data.unread).toBe(1);

    await api().delete(`/api/admin/notifications/${n._id}`).set('Authorization', sa.bearer());
    expect((await get(sa, '/api/admin/notifications')).body.data).toHaveLength(0);
    const forB = (await get(sb, '/api/admin/notifications')).body.data;
    expect(forB).toHaveLength(1);
    expect(forB[0]).toMatchObject({ type: 'payout_requested', read: false, target: { type: 'PayoutRequest' } });
  });

  it('a recurring alert is raised once per key', async () => {
    await notifications.notifyReconciliationDrift({ drift: 12 });
    await notifications.notifyReconciliationDrift({ drift: 12 });
    expect(await Notification.countDocuments({ type: 'reconciliation_drift' })).toBe(1);
  });

  it('new customers notify the admins who manage users', async () => {
    await createUser();
    // Raised best-effort after the save (never blocks sign-up), so wait for it.
    await eventually(async () =>
      expect(await Notification.countDocuments({ type: 'user_registration', requiredPermission: 'canManageUsers' })).toBe(1)
    );
  });
});

describe('analytics', () => {
  it('returns complete daily series for the range in Pakistan days', async () => {
    await User.collection.insertOne({ email: 'x@x.co', fullName: 'X', createdAt: new Date('2026-03-09T20:00:00Z') }); // 10 Mar 01:00 PKT
    const s = await signIn(await createAdmin({ permissions: { canViewAnalytics: true } }));
    const res = await get(s, '/api/admin/analytics?from=2026-03-08&to=2026-03-11');
    expect(res.status).toBe(200);
    expect(res.body.data.users.daily).toEqual([
      { date: '2026-03-08', count: 0 },
      { date: '2026-03-09', count: 0 },
      { date: '2026-03-10', count: 1 },
      { date: '2026-03-11', count: 0 },
    ]);
    expect((await get(s, '/api/admin/analytics?from=2026-03-11&to=2026-03-01')).status).toBe(400);
  });
});

describe('one envelope for every admin response', () => {
  it('success carries data (and meta for lists); failure carries error.code and requestId; never data + stats', async () => {
    const s = await signIn(await createAdmin({ role: 'super_admin' }));
    const paths = [
      '/api/admin/overview',
      '/api/admin/meta',
      '/api/admin/providers',
      '/api/admin/users',
      '/api/admin/notifications',
      '/api/admin/queue',
      '/api/admin/settings',
      '/api/admin/bookings',
      '/api/admin/disputes',
      '/api/admin/wallets',
      '/api/admin/admins',
      '/api/v1/admin/doctors',
      '/api/v1/admin/appointments',
      '/api/v1/admin/analytics/stats',
      '/api/shopping/admin/orders',
      '/api/shopping/admin/brands',
    ];
    for (const path of paths) {
      const res = await get(s, path);
      expect([path, res.status]).toEqual([path, 200]);
      expect(res.body.success).toBe(true);
      expect(res.body).toHaveProperty('data');
      expect(res.body).not.toHaveProperty('stats');
      expect(res.body).not.toHaveProperty('pagination');
    }
    const missing = await get(s, `/api/admin/providers/${new mongoose.Types.ObjectId()}`);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    expect(missing.body.requestId).toEqual(expect.any(String));
    const shop = await get(s, `/api/shopping/admin/orders/${new mongoose.Types.ObjectId()}`);
    expect(shop.body.error).toEqual(expect.objectContaining({ code: expect.any(String) }));
    expect(await AdminAuditLog.countDocuments({ action: /^provider\./ })).toBe(0);
  });
});
