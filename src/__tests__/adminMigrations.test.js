/**
 * The admin data migrations, run as real child processes against this test
 * file's database: they refuse without --confirm-db, do nothing with --dry,
 * fix what they are meant to fix, and are idempotent.
 */
const path = require('path');
const { execFileSync } = require('child_process');
const mongoose = require('mongoose');
const { connect, clear, disconnect } = require('../../test/helpers/db');

const ROOT = path.join(__dirname, '..', '..');
const dbName = () => new URL(process.env.MONGODB_URI).pathname.slice(1);

function run(script, ...args) {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'migrations', script), ...args], {
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}
const confirm = () => `--confirm-db=${dbName()}`;
const db = () => mongoose.connection.db;

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

it('refuses without naming the database', () => {
  const res = run('01-admin-auth-cleanup.js');
  expect(res.code).toBe(1);
  expect(res.out).toMatch(/--confirm-db=/);
});

describe('01-admin-auth-cleanup', () => {
  beforeEach(async () => {
    await db().collection('admins').insertOne({ email: 'a@example.com', refreshToken: 'plain-token' });
    await db().collection('adminsettings').insertOne({
      general: { platformName: 'MM', timezone: 'Asia/Karachi', autoApproveProviders: false },
      security: { sessionTimeout: 30, ipWhitelist: [] },
      appearance: { theme: 'light' },
      healthcare: { commissionPercent: 10, autoApproveDoctors: false },
      homeservice: { commissionPercent: 10, cancellationWindowHours: 2 },
    });
  });

  it('--dry changes nothing', async () => {
    expect(run('01-admin-auth-cleanup.js', confirm(), '--dry').code).toBe(0);
    expect((await db().collection('admins').findOne()).refreshToken).toBe('plain-token');
  });

  it('removes the plaintext refresh token and the unused settings, keeps the used ones, builds indexes', async () => {
    expect(run('01-admin-auth-cleanup.js', confirm()).code).toBe(0);
    expect((await db().collection('admins').findOne()).refreshToken).toBeUndefined();
    const s = await db().collection('adminsettings').findOne();
    expect(s.general).toEqual({ platformName: 'MM' });
    expect(s.security).toEqual({ sessionTimeout: 30 });
    expect(s.appearance).toBeUndefined();
    expect(s.healthcare).toEqual({ commissionPercent: 10 });
    expect(s.homeservice).toEqual({ commissionPercent: 10 });
    const ttl = (await db().collection('adminsessions').indexes()).find((i) => i.expireAfterSeconds !== undefined);
    expect(ttl).toBeDefined();
    expect(run('01-admin-auth-cleanup.js', confirm()).code).toBe(0); // idempotent
  });
});

describe('02-admin-permissions', () => {
  it('makes role and isSuperAdmin agree and adds the new flags conservatively', async () => {
    await db().collection('admins').insertMany([
      { email: 'flag-only@example.com', role: 'admin', isSuperAdmin: true, permissions: {} },
      { email: 'role-only@example.com', role: 'super_admin', permissions: {} },
      { email: 'ops@example.com', role: 'admin', permissions: { canManageShopping: true } },
      { email: 'mod@example.com', role: 'moderator', permissions: { canManageShopping: true } },
    ]);
    expect(run('02-admin-permissions.js', confirm()).code).toBe(0);
    const by = async (email) => db().collection('admins').findOne({ email });
    for (const email of ['flag-only@example.com', 'role-only@example.com']) {
      const a = await by(email);
      expect(a.role).toBe('super_admin');
      expect(a.isSuperAdmin).toBe(true);
      expect(a.permissions.canManageFinance).toBe(true);
    }
    const ops = await by('ops@example.com');
    expect(ops.permissions).toMatchObject({ canManageHomeServices: true, canManageFinance: false, canViewAudit: false, canBroadcast: false });
    const mod = await by('mod@example.com');
    expect(mod.permissions.canManageHomeServices).toBe(false);
  });
});

describe('03-audit-backfill', () => {
  it('copies every old audit store into AdminAuditLog once and drops the embedded log', async () => {
    const adminId = new mongoose.Types.ObjectId();
    await db().collection('hsauditlogs').insertOne({ admin: adminId, action: 'booking.refund', targetType: 'booking', targetId: new mongoose.Types.ObjectId(), reason: 'r', createdAt: new Date('2026-01-02') });
    await db().collection('shoppingauditlogs').insertOne({ admin: adminId, action: 'manual_refund', targetType: 'ShoppingOrder', at: new Date('2026-02-03') });
    await db().collection('walletauditlogs').insertOne({ admin: adminId, action: 'wallet.adjust', targetId: new mongoose.Types.ObjectId(), reason: 'goodwill', createdAt: new Date('2026-03-04') });
    await db().collection('admins').insertOne({
      _id: adminId,
      email: 'old@example.com',
      role: 'admin',
      activityLog: [{ action: 'approve_provider', details: 'Approved X', timestamp: new Date('2025-12-01') }],
      stats: { totalProvidersApproved: 1 },
    });

    expect(run('03-audit-backfill.js', confirm()).code).toBe(0);
    expect(run('03-audit-backfill.js', confirm()).code).toBe(0); // idempotent

    const rows = await db().collection('adminauditlogs').find({}).sort({ createdAt: 1 }).toArray();
    expect(rows.map((r) => r.action)).toEqual([
      'legacy.approve_provider',
      'homeservice.booking.refund',
      'shopping.manual_refund',
      'wallet.adjust',
    ]);
    expect(rows.find((r) => r.module === 'shopping').createdAt).toEqual(new Date('2026-02-03'));
    const admin = await db().collection('admins').findOne({ _id: adminId });
    expect(admin.activityLog).toBeUndefined();
    expect(admin.stats).toBeUndefined();
    // Legacy collections are kept unless --drop-legacy.
    expect(await db().collection('hsauditlogs').countDocuments()).toBe(1);
  });
});
