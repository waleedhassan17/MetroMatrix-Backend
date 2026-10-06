/**
 * Deleting users and providers from the admin console (BE-R5, QA Q16/Q17):
 * refused with the reasons while anything is open, soft otherwise, hidden
 * everywhere, history intact, restorable by a super admin only.
 */
const { connect, clear, disconnect } = require('../../test/helpers/db');
const { createAdmin, createUser, createProvider } = require('../../test/helpers/factories');
const { api, signIn } = require('../../test/helpers/agent');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Provider = require('../models/Provider');
const AdminAuditLog = require('../models/AdminAuditLog');
const Booking = require('../modules/homeservice/models/Booking');
const PayoutRequest = require('../modules/homeservice/models/PayoutRequest');
const { STATUS } = require('../modules/homeservice/services/statusMap');
const { generateAccessToken } = require('../utils/generateToken');

const booking = (customer, provider, status) =>
  Booking.create({
    customer: customer._id,
    provider: provider._id,
    serviceCategory: 'electricians',
    scheduledFor: new Date(Date.now() + 86400000),
    address: { line1: '1 Test Road' },
    status,
  });

const del = (s, path, reason) => api().delete(path).set('Authorization', s.bearer()).send(reason === undefined ? {} : { reason });

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

describe('deleting a user', () => {
  let s;
  beforeEach(async () => {
    s = await signIn(await createAdmin({ permissions: { canManageUsers: true } }));
  });

  it('needs a reason', async () => {
    const user = await createUser();
    const res = await del(s, `/api/admin/users/${user._id}`);
    expect(res.status).toBe(400);
  });

  it('is refused while a booking is open, with the reason', async () => {
    const user = await createUser();
    await booking(user, await createProvider(), STATUS.ACCEPTED);
    const res = await del(s, `/api/admin/users/${user._id}`, 'requested by user');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DELETE_BLOCKED');
    expect(res.body.error.details.reasons).toEqual([expect.objectContaining({ type: 'open_bookings', count: 1 })]);
    expect(await User.findById(user._id)).not.toBeNull();
  });

  it('is refused while the wallet holds money', async () => {
    const user = await createUser();
    // Signing up creates the wallet; give it money.
    await Wallet.updateOne({ owner: user._id, ownerType: 'User' }, { $set: { balance: 250 } }, { upsert: true });
    const res = await del(s, `/api/admin/users/${user._id}`, 'requested by user');
    expect(res.status).toBe(409);
    expect(res.body.error.details.reasons[0]).toMatchObject({ type: 'wallet_balance', amount: 250 });
  });

  it('soft-deletes a clean account: hidden everywhere, signed out, email free, history intact, audited', async () => {
    const user = await createUser();
    const provider = await createProvider();
    const past = await booking(user, provider, STATUS.COMPLETED);
    const token = generateAccessToken(user._id, { userType: 'user' });
    expect((await api().get('/api/users/profile').set('Authorization', `Bearer ${token}`)).status).toBe(200);

    const res = await del(s, `/api/admin/users/${user._id}`, 'requested by user');
    expect(res.status).toBe(200);
    expect(res.body.data.restorable).toBe(true);

    // Gone from queries and lists…
    expect(await User.findById(user._id)).toBeNull();
    expect(await User.countDocuments({})).toBe(0);
    const list = await api().get('/api/admin/users').set('Authorization', s.bearer());
    expect(JSON.stringify(list.body)).not.toContain(user.email);
    // …but still in the database for history and restore.
    const kept = await User.findOne({ _id: user._id }).setOptions({ withDeleted: true }).select('+deletedEmail');
    expect(kept.deletedEmail).toBe(user.email);
    expect(kept.deleteReason).toBe('requested by user');
    // Signed out on the next request.
    expect((await api().get('/api/users/profile').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    // A past booking still shows who it was with.
    const populated = await Booking.findById(past._id).populate('customer', 'fullName');
    expect(populated.customer.fullName).toBe(user.fullName);
    // The address can register again.
    await expect(createUser({ email: user.email })).resolves.toBeTruthy();

    const row = await AdminAuditLog.findOne({ action: 'user.delete' }).lean();
    expect(String(row.targetId)).toBe(String(user._id));
    expect(row.reason).toBe('requested by user');
  });

  it('only a super admin restores, and not over an email someone took since', async () => {
    const user = await createUser();
    await del(s, `/api/admin/users/${user._id}`, 'mistake');
    expect((await api().post(`/api/admin/users/${user._id}/restore`).set('Authorization', s.bearer())).status).toBe(403);

    const boss = await signIn(await createAdmin({ role: 'super_admin' }));
    const taken = await createUser({ email: user.email });
    const conflict = await api().post(`/api/admin/users/${user._id}/restore`).set('Authorization', boss.bearer());
    expect(conflict.status).toBe(409);

    await User.deleteOne({ _id: taken._id });
    const ok = await api().post(`/api/admin/users/${user._id}/restore`).set('Authorization', boss.bearer());
    expect(ok.status).toBe(200);
    const back = await User.findById(user._id);
    expect(back.email).toBe(user.email);
    expect(back.isActive).toBe(true);
    expect(await AdminAuditLog.countDocuments({ action: 'user.restore' })).toBe(1);
  });
});

describe('deleting a provider', () => {
  it('is refused while a payout request is pending', async () => {
    const s = await signIn(await createAdmin({ permissions: { canApproveProviders: true } }));
    const provider = await createProvider();
    await PayoutRequest.create({ provider: provider._id, amount: 1000 });
    const res = await del(s, `/api/admin/providers/${provider._id}`, 'closing account');
    expect(res.status).toBe(409);
    expect(res.body.error.details.reasons.map((r) => r.type)).toEqual(['pending_payouts']);
  });

  it('soft-deletes a clean provider', async () => {
    const s = await signIn(await createAdmin({ permissions: { canApproveProviders: true } }));
    const provider = await createProvider();
    const res = await del(s, `/api/admin/providers/${provider._id}`, 'closing account');
    expect(res.status).toBe(200);
    expect(await Provider.findById(provider._id)).toBeNull();
    expect(await Provider.countDocuments({ _id: { $in: [provider._id] } })).toBe(1); // id-batch lookups (populate) still see it
    expect(await AdminAuditLog.countDocuments({ action: 'provider.delete' })).toBe(1);
  });

  it('aggregations skip deleted accounts', async () => {
    const s = await signIn(await createAdmin({ permissions: { canApproveProviders: true } }));
    const a = await createProvider();
    await createProvider();
    await del(s, `/api/admin/providers/${a._id}`, 'x');
    const rows = await Provider.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }]);
    expect(rows[0].n).toBe(1);
  });
});

describe('listing deleted accounts, to restore one', () => {
  const list = (s, path) => api().get(path).set('Authorization', s.bearer());

  it('only a super admin sees them, with the real email and the reason', async () => {
    const manager = await signIn(await createAdmin({ permissions: { canManageUsers: true } }));
    const kept = await createUser();
    const gone = await createUser();
    await del(manager, `/api/admin/users/${gone._id}`, 'asked to close');

    expect((await list(manager, '/api/admin/users?status=deleted')).status).toBe(403);

    const boss = await signIn(await createAdmin({ role: 'super_admin' }));
    const res = await list(boss, '/api/admin/users?status=deleted');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([expect.objectContaining({ id: String(gone._id), email: gone.email, deleteReason: 'asked to close', deletedAt: expect.any(String) })]);
    expect(res.body.meta.counts.deleted).toBe(1);

    // The usual list neither shows it nor carries deleted fields.
    const usual = await list(boss, '/api/admin/users');
    expect(usual.body.data.map((u) => u.id)).toEqual([String(kept._id)]);
    expect(usual.body.data[0]).not.toHaveProperty('deletedAt');
  });

  it('pages past the first page (a cursor must not hide them again)', async () => {
    const boss = await signIn(await createAdmin({ role: 'super_admin' }));
    const users = await Promise.all([1, 2, 3].map(() => createUser()));
    for (const u of users) await del(boss, `/api/admin/users/${u._id}`, 'tidy');
    const first = await list(boss, '/api/admin/users?status=deleted&limit=2');
    expect(first.body.data).toHaveLength(2);
    expect(first.body.meta.nextCursor).toEqual(expect.any(String));
    const second = await list(boss, `/api/admin/users?status=deleted&limit=2&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`);
    expect(second.body.data).toHaveLength(1);
    expect([...first.body.data, ...second.body.data].map((u) => u.id).sort()).toEqual(users.map((u) => String(u._id)).sort());
  });

  it('deleted providers too, for a super admin only', async () => {
    const approver = await signIn(await createAdmin({ permissions: { canApproveProviders: true } }));
    const provider = await createProvider();
    await del(approver, `/api/admin/providers/${provider._id}`, 'duplicate account');
    expect((await list(approver, '/api/admin/providers?state=deleted')).status).toBe(403);
    const boss = await signIn(await createAdmin({ role: 'super_admin' }));
    const res = await list(boss, '/api/admin/providers?state=deleted');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([expect.objectContaining({ id: String(provider._id), email: provider.email, deleteReason: 'duplicate account' })]);
    expect(res.body.meta.counts.deleted).toBe(1);
  });
});
