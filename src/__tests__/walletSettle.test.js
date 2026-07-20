/**
 * PART C — proves WalletService.settle() / settlePayout() / reversePayout()
 * against a REAL MongoDB connection: atomic three-leg money movement
 * (payer debit, payee credit-minus-commission, Platform commission credit),
 * idempotency, insufficient-balance rejection, and the deferred-payout
 * pattern healthcare/shopping use (pay now, earn+commission later, reverse
 * on refund).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const WalletService = require('../services/walletService');

const hasDb = !!process.env.MONGODB_URI;
const d = hasDb ? describe : describe.skip;
jest.setTimeout(30000);

d('WalletService.settle() / settlePayout() / reversePayout() (real MongoDB)', () => {
  let payerId, payeeId, relatedId;

  beforeEach(() => {
    payerId = new mongoose.Types.ObjectId();
    payeeId = new mongoose.Types.ObjectId();
    relatedId = new mongoose.Types.ObjectId();
  });

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  const cleanup = async (ids) => {
    const wallets = await Wallet.find({ owner: { $in: ids } });
    await WalletTransaction.deleteMany({ wallet: { $in: wallets.map((w) => w._id) } });
    await Wallet.deleteMany({ owner: { $in: ids } });
  };

  it('debits the payer, credits the payee minus commission, and credits Platform with the commission — atomically', async () => {
    await Wallet.create({ owner: payerId, ownerType: 'User', balance: 1000 });

    const result = await WalletService.settle({
      payerType: 'User',
      payerId,
      payeeType: 'Provider',
      payeeId,
      amount: 500,
      source: 'homeservice_payment',
      relatedTo: { kind: 'Booking', id: relatedId },
      commissionRate: 10,
    });

    expect(result.commission).toBe(50);
    expect(result.payerTransaction.source).toBe('homeservice_payment');
    expect(result.payeeTransaction.source).toBe('homeservice_earning');
    expect(result.payeeTransaction.amount).toBe(450);
    expect(result.commissionTransaction.source).toBe('commission');
    expect(result.commissionTransaction.amount).toBe(50);

    const [payerWallet, payeeWallet, platformWallet] = await Promise.all([
      Wallet.findOne({ owner: payerId, ownerType: 'User' }),
      Wallet.findOne({ owner: payeeId, ownerType: 'Provider' }),
      WalletService.getPlatformWallet(),
    ]);
    expect(payerWallet.balance).toBe(500); // 1000 - 500
    expect(payeeWallet.balance).toBe(450); // 500 - 10% commission
    expect(platformWallet.balance).toBeGreaterThanOrEqual(50);

    // relatedTo traces every leg back to the booking
    const txns = await WalletTransaction.find({ 'relatedTo.id': relatedId });
    expect(txns).toHaveLength(3);
    expect(txns.every((t) => t.relatedTo.kind === 'Booking')).toBe(true);

    await cleanup([payerId, payeeId]);
  });

  it('rejects when the payer cannot cover the amount, and moves nothing', async () => {
    await Wallet.create({ owner: payerId, ownerType: 'User', balance: 10 });

    await expect(
      WalletService.settle({
        payerType: 'User',
        payerId,
        payeeType: 'Provider',
        payeeId,
        amount: 500,
        source: 'homeservice_payment',
        relatedTo: { kind: 'Booking', id: relatedId },
        commissionRate: 10,
      })
    ).rejects.toThrow(/insufficient/i);

    const payerWallet = await Wallet.findOne({ owner: payerId, ownerType: 'User' });
    expect(payerWallet.balance).toBe(10); // untouched
    // getOrCreateWallet touches the payee wallet before the balance check
    // (same pattern transferFunds already uses) — it may now exist, but
    // must never have been credited.
    const payeeWallet = await Wallet.findOne({ owner: payeeId, ownerType: 'Provider' });
    if (payeeWallet) expect(payeeWallet.balance).toBe(0);

    await cleanup([payerId, payeeId]);
  });

  it('is idempotent: replaying the same idempotencyKey does not move money twice', async () => {
    await Wallet.create({ owner: payerId, ownerType: 'User', balance: 1000 });
    const key = `settle-test-${relatedId}`;

    const first = await WalletService.settle({
      payerType: 'User',
      payerId,
      payeeType: 'Provider',
      payeeId,
      amount: 200,
      source: 'homeservice_payment',
      relatedTo: { kind: 'Booking', id: relatedId },
      commissionRate: 0,
      idempotencyKey: key,
    });
    expect(first.alreadyProcessed).toBe(false);

    const second = await WalletService.settle({
      payerType: 'User',
      payerId,
      payeeType: 'Provider',
      payeeId,
      amount: 200,
      source: 'homeservice_payment',
      relatedTo: { kind: 'Booking', id: relatedId },
      commissionRate: 0,
      idempotencyKey: key,
    });
    expect(second.alreadyProcessed).toBe(true);

    const payerWallet = await Wallet.findOne({ owner: payerId, ownerType: 'User' });
    expect(payerWallet.balance).toBe(800); // debited exactly once

    await cleanup([payerId, payeeId]);
  });

  it('settlePayout() credits payee + commission without a payer leg, and reversePayout() undoes it', async () => {
    const payout = await WalletService.settlePayout({
      payeeType: 'Provider',
      payeeId,
      amount: 1000,
      source: 'shopping_earning',
      relatedTo: { kind: 'Order', id: relatedId },
      commissionRate: 12,
    });
    expect(payout.commission).toBe(120);
    expect(payout.payeeTransaction.amount).toBe(880);

    let payeeWallet = await Wallet.findOne({ owner: payeeId, ownerType: 'Provider' });
    expect(payeeWallet.balance).toBe(880);

    const reversal = await WalletService.reversePayout({
      payeeType: 'Provider',
      payeeId,
      relatedTo: { kind: 'Order', id: relatedId },
    });
    expect(reversal.source).toBe('refund');
    expect(reversal.amount).toBe(880);

    payeeWallet = await Wallet.findOne({ owner: payeeId, ownerType: 'Provider' });
    expect(payeeWallet.balance).toBe(0);

    // idempotent — calling again does not debit a second time
    const again = await WalletService.reversePayout({
      payeeType: 'Provider',
      payeeId,
      relatedTo: { kind: 'Order', id: relatedId },
    });
    expect(String(again._id)).toBe(String(reversal._id));

    await cleanup([payeeId]);
  });
});
