/**
 * The admin data migrations, run as real child processes against this test
 * file's database: they refuse without --confirm-db, do nothing with --dry,
 * fix what they are meant to fix, and are idempotent.
 *
 * The child runs ASYNCHRONOUSLY. Under --runInBand (npm test, CI) the test
 * runs in the same process that started the in-memory MongoDB and drains its
 * output; execFileSync blocked that process, mongod's output pipe filled, it
 * stopped answering, and the migration waited on it forever — npm test hung
 * here with nothing failing.
 */
const path = require('path');
const { execFile } = require('child_process');
const mongoose = require('mongoose');
const { connect, clear, disconnect } = require('../../test/helpers/db');

const ROOT = path.join(__dirname, '..', '..');
const dbName = () => new URL(process.env.MONGODB_URI).pathname.slice(1);

function run(script, ...args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT, 'scripts', 'migrations', script), ...args],
      { env: process.env, encoding: 'utf8', timeout: 60_000 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, out: stdout });
        resolve({ code: typeof err.code === 'number' ? err.code : 1, out: `${stdout || ''}${stderr || ''}` });
      }
    );
  });
}
const confirm = () => `--confirm-db=${dbName()}`;
const db = () => mongoose.connection.db;

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

it('refuses without naming the database', async () => {
  const res = await run('01-admin-auth-cleanup.js');
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
    expect((await run('01-admin-auth-cleanup.js', confirm(), '--dry')).code).toBe(0);
    expect((await db().collection('admins').findOne()).refreshToken).toBe('plain-token');
  });

  it('removes the plaintext refresh token and the unused settings, keeps the used ones, builds indexes', async () => {
    expect((await run('01-admin-auth-cleanup.js', confirm())).code).toBe(0);
    expect((await db().collection('admins').findOne()).refreshToken).toBeUndefined();
    const s = await db().collection('adminsettings').findOne();
    expect(s.general).toEqual({ platformName: 'MM' });
    expect(s.security).toEqual({ sessionTimeout: 30 });
    expect(s.appearance).toBeUndefined();
    expect(s.healthcare).toEqual({ commissionPercent: 10 });
    expect(s.homeservice).toEqual({ commissionPercent: 10 });
    const ttl = (await db().collection('adminsessions').indexes()).find((i) => i.expireAfterSeconds !== undefined);
    expect(ttl).toBeDefined();
    expect((await run('01-admin-auth-cleanup.js', confirm())).code).toBe(0); // idempotent
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
    expect((await run('02-admin-permissions.js', confirm())).code).toBe(0);
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

    expect((await run('03-audit-backfill.js', confirm())).code).toBe(0);
    expect((await run('03-audit-backfill.js', confirm())).code).toBe(0); // idempotent

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

describe('04-provider-status', () => {
  it('derives the state model from what each record says happened', async () => {
    await db().collection('providers').insertMany([
      { email: 'live@x.co', adminVerified: 'active', isActive: true },
      { email: 'switched-off@x.co', adminVerified: 'active', isActive: false },
      { email: 'rejected@x.co', adminVerified: 'inactive', rejectionReason: 'Fake documents' },
      { email: 'approved-then-off@x.co', adminVerified: 'inactive', approvedAt: new Date('2026-01-01') },
      { email: 'waiting@x.co', adminVerified: 'pending' },
    ]);
    expect((await run('04-provider-status.js', confirm())).code).toBe(0);
    const by = async (email) => db().collection('providers').findOne({ email });
    expect(await by('live@x.co')).toMatchObject({ verificationStatus: 'approved', isSuspended: false });
    expect(await by('switched-off@x.co')).toMatchObject({ verificationStatus: 'approved', isSuspended: true });
    expect(await by('rejected@x.co')).toMatchObject({ verificationStatus: 'rejected', isSuspended: false });
    expect(await by('approved-then-off@x.co')).toMatchObject({ verificationStatus: 'approved', isSuspended: true });
    expect(await by('waiting@x.co')).toMatchObject({ verificationStatus: 'pending', isSuspended: false });
    // Login flags untouched.
    expect((await by('switched-off@x.co')).adminVerified).toBe('active');
    expect((await run('04-provider-status.js', confirm())).out).toMatch(/"changed":0/);
  });
});

describe('05-notification-read-state', () => {
  it('turns the global isRead flag into per-admin read state', async () => {
    const [a1, a2] = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    await db().collection('admins').insertMany([{ _id: a1, email: 'a1@x.co' }, { _id: a2, email: 'a2@x.co' }]);
    const providerId = new mongoose.Types.ObjectId();
    await db().collection('notifications').insertMany([
      { type: 'provider_registration', title: 't', message: 'm', isRead: true, readAt: new Date(), data: { providerId, severity: 'warning' } },
      { type: 'system_alert', title: 't', message: 'm', isRead: false },
    ]);
    expect((await run('05-notification-read-state.js', confirm())).code).toBe(0);
    const [read, unread] = await db().collection('notifications').find({}).sort({ type: 1 }).toArray();
    expect(read.readBy.map(String).sort()).toEqual([a1, a2].map(String).sort());
    expect(read.isRead).toBeUndefined();
    expect(read.severity).toBe('warning');
    expect(read.target).toEqual({ type: 'Provider', id: providerId });
    expect(unread.readBy).toEqual([]);
  });
});

describe('audit-prod-hygiene', () => {
  // Asynchronous for the same reason as run() above.
  const hygiene = (...args) =>
    new Promise((resolve) => {
      execFile(process.execPath, [path.join(ROOT, 'scripts', 'audit-prod-hygiene.js'), ...args], { env: process.env, encoding: 'utf8', timeout: 60_000 }, (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, out: stdout });
        resolve({ code: typeof err.code === 'number' ? err.code : 1, out: `${stdout || ''}${stderr || ''}` });
      });
    });

  it('finds seeded accounts and known passwords read-only, and cleans up with --apply', async () => {
    const User = require('../models/User');
    const Admin = require('../models/Admin');
    await User.create({ email: 'user1@metromatrix.pk', fullName: 'Demo', phoneNumber: '03001234567', password: '123456' });
    await User.create({ email: 'real@gmail.com', fullName: 'Real', phoneNumber: '03001234568', password: 'A-Real-Password-9' });
    await Admin.create({ email: 'old-admin@gmail.com', fullName: 'Old', role: 'admin', password: 'Moderator@123456' });
    await Admin.create({ email: 'boss@gmail.com', fullName: 'Boss', role: 'super_admin', password: 'Strong-Unique-Pass-1' });

    const look = await hygiene(confirm());
    expect(look.code).toBe(0);
    expect(look.out).toMatch(/user1@metromatrix\.pk/);
    expect(look.out).toMatch(/old-admin@gmail\.com/);
    expect(look.out).not.toMatch(/real@gmail\.com|boss@gmail\.com/);
    expect(await User.countDocuments({})).toBe(2); // read-only

    expect((await hygiene(confirm(), '--apply')).code).toBe(0);
    expect(await User.findOne({ email: 'real@gmail.com' })).not.toBeNull();
    expect(await User.countDocuments({})).toBe(1); // demo account soft-deleted
    expect((await Admin.findOne({ email: 'old-admin@gmail.com' })).isActive).toBe(false);
    expect((await Admin.findOne({ email: 'boss@gmail.com' })).isActive).toBe(true);
  }, 60000);
});

describe('06-remove-commission', () => {
  const wallet = new mongoose.Types.ObjectId();
  beforeEach(async () => {
    await db().collection('adminsettings').insertOne({
      shopping: { commissionPercent: 10, shippingFeePerBrand: 150 },
      healthcare: { commissionPercent: 10, cancellationWindowHours: 2 },
      homeservice: { commissionPercent: 10, minPayoutAmount: 500 },
    });
    await db().collection('wallettransactions').insertMany([
      { wallet, type: 'debit', amount: 120, source: 'commission', status: 'pending' },
      { wallet, type: 'debit', amount: 80, source: 'commission', status: 'completed' },
      { wallet, type: 'debit', amount: 50, source: 'payout', status: 'pending' },
    ]);
  });

  it('--dry changes nothing', async () => {
    const res = await run('06-remove-commission.js', confirm(), '--dry');
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/waived: 1 \(total 120\)/);
    expect((await db().collection('adminsettings').findOne()).shopping.commissionPercent).toBe(10);
    expect(await db().collection('wallettransactions').countDocuments({ status: 'pending' })).toBe(2);
  });

  it('unsets the settings, waives only pending commission debits with an audit row, and is idempotent', async () => {
    expect((await run('06-remove-commission.js', confirm())).code).toBe(0);
    const s = await db().collection('adminsettings').findOne();
    expect(s.shopping).toEqual({ shippingFeePerBrand: 150 });
    expect(s.healthcare).toEqual({ cancellationWindowHours: 2 });
    expect(s.homeservice).toEqual({ minPayoutAmount: 500 });

    const txs = db().collection('wallettransactions');
    const waived = await txs.findOne({ amount: 120 });
    expect(waived.status).toBe('failed');
    expect(waived.metadata.waived).toBe(true);
    expect((await txs.findOne({ amount: 80 })).status).toBe('completed'); // already taken: history
    expect((await txs.findOne({ amount: 50 })).status).toBe('pending'); // not a commission

    const audits = await db().collection('adminauditlogs').find({ action: 'wallet.commission.waive' }).toArray();
    expect(audits).toHaveLength(1);
    expect(String(audits[0].targetId)).toBe(String(waived._id));

    expect((await run('06-remove-commission.js', confirm())).code).toBe(0);
    expect(await db().collection('adminauditlogs').countDocuments({ action: 'wallet.commission.waive' })).toBe(1);
  });
});
