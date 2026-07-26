/**
 * WALLET_AUDIT.md P1-1 / P1-2 — proves the ledger primitives that replaced
 * the hand-rolled `wallet.debit()` + `recordTransaction()` pairs scattered
 * across the shopping, healthcare and home-service payment paths:
 *
 *   payWithSettle()  — payer leg: debit + ledger row as ONE unit
 *   refund()         — credit + ledger row as ONE unit
 *   debitOrDefer()   — collect if possible, otherwise record a PENDING debt
 *
 * Run against a REAL MongoDB connection so the atomic $inc guards are
 * genuinely exercised rather than mocked away.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const WalletService = require('../services/walletService');

const hasDb = !!process.env.MONGODB_URI;
const d = hasDb ? describe : describe.skip;
jest.setTimeout(30000);

d('Wallet ledger primitives (real MongoDB)', () => {
  let ownerId, relatedId;

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  beforeEach(() => {
    ownerId = new mongoose.Types.ObjectId();
    relatedId = new mongoose.Types.ObjectId();
  });

  afterEach(async () => {
    const wallets = await Wallet.find({ owner: ownerId });
    await WalletTransaction.deleteMany({ wallet: { $in: wallets.map((w) => w._id) } });
    await Wallet.deleteMany({ owner: ownerId });
  });

  describe('payWithSettle()', () => {
    it('debits the payer and writes a linked ledger row', async () => {
      await Wallet.create({ owner: ownerId, ownerType: 'User', balance: 5000 });

      const { payerWallet, payerTransaction } = await WalletService.payWithSettle({
        payerType: 'User',
        payerId: ownerId,
        amount: 2000,
        source: 'shopping_payment',
        relatedTo: { kind: 'OrderGroup', id: relatedId },
        description: 'Test order',
      });

      expect(payerWallet.balance).toBe(3000);
      expect(payerTransaction.type).toBe('debit');
      expect(payerTransaction.amount).toBe(2000);
      expect(payerTransaction.status).toBe('completed');
      expect(payerTransaction.source).toBe('shopping_payment');
      expect(String(payerTransaction.relatedTo.id)).toBe(String(relatedId));
    });

    it('refuses to overdraw and leaves the balance untouched', async () => {
      await Wallet.create({ owner: ownerId, ownerType: 'User', balance: 500 });

      await expect(
        WalletService.payWithSettle({
          payerType: 'User',
          payerId: ownerId,
          amount: 2000,
          source: 'shopping_payment',
          relatedTo: { kind: 'OrderGroup', id: relatedId },
        })
      ).rejects.toThrow(/Insufficient balance/);

      const w = await Wallet.findOne({ owner: ownerId });
      expect(w.balance).toBe(500);
      // No partial debit means no orphan ledger row either.
      expect(await WalletTransaction.countDocuments({ wallet: w._id })).toBe(0);
    });

    it('is idempotent on idempotencyKey — a replayed payment debits once', async () => {
      await Wallet.create({ owner: ownerId, ownerType: 'User', balance: 5000 });
      const args = {
        payerType: 'User',
        payerId: ownerId,
        amount: 1000,
        source: 'shopping_payment',
        relatedTo: { kind: 'OrderGroup', id: relatedId },
        idempotencyKey: `test-${relatedId}`,
      };

      const first = await WalletService.payWithSettle(args);
      const second = await WalletService.payWithSettle(args);

      expect(first.alreadyProcessed).toBe(false);
      expect(second.alreadyProcessed).toBe(true);
      expect(String(first.payerTransaction._id)).toBe(String(second.payerTransaction._id));

      const w = await Wallet.findOne({ owner: ownerId });
      expect(w.balance).toBe(4000); // debited once, not twice
    });
  });

  describe('refund()', () => {
    it('credits the wallet and writes a refund ledger row', async () => {
      await Wallet.create({ owner: ownerId, ownerType: 'User', balance: 1000 });

      const { wallet, transaction } = await WalletService.refund({
        ownerType: 'User',
        ownerId,
        amount: 750,
        relatedTo: { kind: 'Order', id: relatedId },
        description: 'Cancelled order',
      });

      expect(wallet.balance).toBe(1750);
      expect(transaction.type).toBe('credit');
      expect(transaction.source).toBe('refund');
      expect(transaction.status).toBe('completed');
    });

    it('is idempotent on idempotencyKey — a replayed refund credits once', async () => {
      await Wallet.create({ owner: ownerId, ownerType: 'User', balance: 1000 });
      const args = {
        ownerType: 'User',
        ownerId,
        amount: 500,
        relatedTo: { kind: 'Order', id: relatedId },
        idempotencyKey: `refund-${relatedId}`,
      };

      await WalletService.refund(args);
      const second = await WalletService.refund(args);

      expect(second.alreadyProcessed).toBe(true);
      const w = await Wallet.findOne({ owner: ownerId });
      expect(w.balance).toBe(1500); // credited once
    });
  });

  describe('debitOrDefer()', () => {
    it('collects the penalty when the balance covers it', async () => {
      await Wallet.create({ owner: ownerId, ownerType: 'Provider', balance: 1000 });

      const { wallet, transaction, collected } = await WalletService.debitOrDefer({
        ownerType: 'Provider',
        ownerId,
        amount: 300,
        relatedTo: { kind: 'Booking', id: relatedId },
        description: 'Dispute penalty',
      });

      expect(collected).toBe(true);
      expect(wallet.balance).toBe(700);
      expect(transaction.status).toBe('completed');
    });

    it('records a PENDING debt without mutating the balance when it cannot be covered', async () => {
      await Wallet.create({ owner: ownerId, ownerType: 'Provider', balance: 100 });

      const { wallet, transaction, collected } = await WalletService.debitOrDefer({
        ownerType: 'Provider',
        ownerId,
        amount: 500,
        relatedTo: { kind: 'Booking', id: relatedId },
        description: 'Dispute penalty',
      });

      // This is the bug the primitive exists to prevent: the old call site
      // guarded on `balance >= 0` (always true) and marked every penalty
      // 'completed' even when no money moved.
      expect(collected).toBe(false);
      expect(wallet.balance).toBe(100);
      expect(transaction.status).toBe('pending');
      expect(transaction.amount).toBe(500);
    });
  });
});
