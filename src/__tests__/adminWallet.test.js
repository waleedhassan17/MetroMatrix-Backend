/**
 * Admin wallet oversight — manual adjustments (maker-checker) and
 * reconciliation, through the real endpoints on the in-memory replica set.
 *
 *  - at or below finance.adjustmentApprovalThreshold: applied at once; the
 *    balance change and the ledger row land together (one transaction) and
 *    one audit row is written (QA Q19, below);
 *  - above it: pending until a DIFFERENT super admin approves (Q19, above);
 *  - an insufficient-balance debit fails cleanly and moves nothing;
 *  - reconciliation stays balanced across a fresh top-up → settle cycle.
 */
const mongoose = require('mongoose');
const { connect, clear, disconnect } = require('../../test/helpers/db');
const { createAdmin, createWallet } = require('../../test/helpers/factories');
const { api, signIn } = require('../../test/helpers/agent');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const WalletAdjustment = require('../models/WalletAdjustment');
const AdminAuditLog = require('../models/AdminAuditLog');
const AdminSettings = require('../models/AdminSettings');
const WalletService = require('../services/walletService');
const settingsCache = require('../services/settingsCache');

const finance = { canManageFinance: true };
const adjust = (s, walletId, body) => api().post(`/api/admin/wallets/${walletId}/adjust`).set('Authorization', s.bearer()).send(body);
const decide = (s, id, verb, body = {}) =>
  api().post(`/api/admin/wallets/adjustments/${id}/${verb}`).set('Authorization', s.bearer()).send(body);

let wallet;
beforeAll(connect);
beforeEach(async () => {
  wallet = await createWallet(new mongoose.Types.ObjectId(), 'User', 500);
});
afterEach(async () => {
  settingsCache.invalidate();
  await clear();
});
afterAll(disconnect);

describe('manual adjustment at or below the approval threshold', () => {
  it('needs a reason', async () => {
    const s = await signIn(await createAdmin({ permissions: finance }));
    const res = await adjust(s, wallet._id, { type: 'credit', amount: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.map((f) => f.field)).toContain('reason');
    expect((await Wallet.findById(wallet._id)).balance).toBe(500);
  });

  it('applies at once: balance, ledger row and audit row together', async () => {
    const admin = await createAdmin({ permissions: finance });
    const s = await signIn(admin);
    const res = await adjust(s, wallet._id, { type: 'credit', amount: 200, reason: 'Goodwill credit — ticket #42' });
    expect(res.status).toBe(200);
    expect(res.body.data.requiresApproval).toBe(false);
    expect(res.body.data.wallet.balance).toBe(700);
    expect(res.body.data.adjustment.status).toBe('applied');

    const txns = await WalletTransaction.find({ wallet: wallet._id, source: 'admin_adjustment' });
    expect(txns).toHaveLength(1);
    expect(txns[0].amount).toBe(200);
    expect(txns[0].idempotencyKey).toBe(`admin_adjustment:${res.body.data.adjustment.id}`);

    const rows = await AdminAuditLog.find({ action: 'wallet.adjust.applied' }).lean();
    expect(rows).toHaveLength(1);
    expect(String(rows[0].actor)).toBe(String(admin._id));
    expect(rows[0].before).toEqual({ balance: 500 });
    expect(rows[0].after).toEqual({ balance: 700 });
    expect(rows[0].reason).toMatch(/goodwill/i);
  });

  it('refuses a debit the balance cannot cover and moves nothing', async () => {
    const s = await signIn(await createAdmin({ permissions: finance }));
    const res = await adjust(s, wallet._id, { type: 'debit', amount: 900, reason: 'test' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect((await Wallet.findById(wallet._id)).balance).toBe(500);
    expect(await WalletTransaction.countDocuments({ wallet: wallet._id })).toBe(0);
    expect((await WalletAdjustment.findOne()).status).toBe('failed');
  });

  it('an adjustment is applied at most once, whatever happens', async () => {
    const admin = await createAdmin({ permissions: finance });
    const adj = await WalletAdjustment.create({
      wallet: wallet._id,
      direction: 'credit',
      amount: 50,
      reason: 'x',
      requestedBy: admin._id,
      status: 'applying',
    });
    await WalletService.applyAdminAdjustment(adj);
    await expect(WalletService.applyAdminAdjustment(adj)).rejects.toThrow();
    expect((await Wallet.findById(wallet._id)).balance).toBe(550);
    expect(await WalletTransaction.countDocuments({ wallet: wallet._id })).toBe(1);
  });
});

describe('above the approval threshold (maker-checker)', () => {
  beforeEach(async () => {
    await AdminSettings.updateSettings('finance', { adjustmentApprovalThreshold: 1000 });
    settingsCache.invalidate();
  });

  it('waits for a different super admin, then applies', async () => {
    const maker = await createAdmin({ role: 'super_admin' });
    const checker = await createAdmin({ role: 'super_admin' });
    const sm = await signIn(maker);
    const req = await adjust(sm, wallet._id, { type: 'credit', amount: 5000, reason: 'Disputed top-up' });
    expect(req.status).toBe(202);
    expect(req.body.data.requiresApproval).toBe(true);
    expect((await Wallet.findById(wallet._id)).balance).toBe(500);

    // The requester can't approve their own.
    const own = await decide(sm, req.body.data.adjustment.id, 'approve');
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe('SECOND_APPROVER_REQUIRED');

    const sc = await signIn(checker);
    const ok = await decide(sc, req.body.data.adjustment.id, 'approve', { note: 'Checked the Stripe dashboard' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.wallet.balance).toBe(5500);
    expect((await WalletAdjustment.findById(req.body.data.adjustment.id)).decidedBy.toString()).toBe(String(checker._id));

    // Already decided: a second approval is refused.
    expect((await decide(sc, req.body.data.adjustment.id, 'approve')).status).toBe(409);
    expect(await AdminAuditLog.countDocuments({ action: 'wallet.adjust.requested' })).toBe(1);
    expect(await AdminAuditLog.countDocuments({ action: 'wallet.adjust.applied' })).toBe(1);
  });

  it('a finance admin who is not a super admin can request but not approve', async () => {
    const maker = await createAdmin({ permissions: finance });
    const otherFinance = await createAdmin({ permissions: finance });
    const req = await adjust(await signIn(maker), wallet._id, { type: 'credit', amount: 5000, reason: 'x' });
    expect(req.status).toBe(202);
    const res = await decide(await signIn(otherFinance), req.body.data.adjustment.id, 'approve');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SUPER_ADMIN_REQUIRED');
  });

  it('rejecting leaves the balance untouched', async () => {
    const maker = await createAdmin({ role: 'super_admin' });
    const checker = await createAdmin({ role: 'super_admin' });
    const req = await adjust(await signIn(maker), wallet._id, { type: 'debit', amount: 400, reason: 'x' });
    // 400 ≤ 1000 → applied immediately; use a bigger one for the rejection path.
    expect(req.status).toBe(200);
    const big = await adjust(await signIn(maker), wallet._id, { type: 'credit', amount: 2000, reason: 'x' });
    const res = await decide(await signIn(checker), big.body.data.adjustment.id, 'reject', { note: 'No evidence' });
    expect(res.status).toBe(200);
    expect(res.body.data.adjustment.status).toBe('rejected');
    expect((await Wallet.findById(wallet._id)).balance).toBe(100);
  });

  it('lists pending adjustments for the finance team', async () => {
    const maker = await createAdmin({ role: 'super_admin' });
    const s = await signIn(maker);
    await adjust(s, wallet._id, { type: 'credit', amount: 2000, reason: 'x' });
    const res = await api().get('/api/admin/wallets/adjustments?status=pending').set('Authorization', s.bearer());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.total).toBe(1);
  });
});

describe('reconciliation', () => {
  it('a fresh top-up + settle() cycle reconciles (no drift)', async () => {
    const s = await signIn(await createAdmin({ permissions: finance }));
    const payerId = new mongoose.Types.ObjectId();
    const payerWallet = await Wallet.create({ owner: payerId, ownerType: 'User', balance: 0 });
    await Wallet.creditAtomic(payerWallet._id, 1000);
    await WalletTransaction.create({
      wallet: payerWallet._id,
      type: 'credit',
      amount: 1000,
      description: 'test topup',
      source: 'stripe_topup',
      status: 'completed',
    });
    // The 500 seeded into `wallet` has no top-up behind it; record it as an
    // admin adjustment so the ledger explains it.
    await WalletTransaction.create({
      wallet: wallet._id,
      type: 'credit',
      amount: 500,
      description: 'seed',
      source: 'admin_adjustment',
      status: 'completed',
    });
    await WalletService.settle({
      payerType: 'User',
      payerId,
      payeeType: 'Provider',
      payeeId: new mongoose.Types.ObjectId(),
      amount: 400,
      source: 'homeservice_payment',
      relatedTo: { kind: 'Booking', id: new mongoose.Types.ObjectId() },
      commissionRate: 10,
    });
    const res = await api().get('/api/admin/wallets/reconciliation').set('Authorization', s.bearer());
    expect(res.status).toBe(200);
    expect(res.body.data.drift).toBeCloseTo(0, 2);
    expect(res.body.data.balanced).toBe(true);
  });
});
