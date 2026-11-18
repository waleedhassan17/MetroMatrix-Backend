/**
 * A top-up credits exactly the PKR the customer asked for.
 *
 * Top-ups are charged in USD cents (Stripe cannot charge PKR). One cent is
 * PKR 2.80, so converting the charged cents back to PKR is off by up to a
 * rupee: PKR 5,000 → 1,786 cents → PKR 5,001. The wallet used to be credited
 * that converted figure while the history row said 5,000, so topping up 5,000
 * and paying 2,500 twice left PKR 1 that nothing in the history explained.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const WalletService = require('../services/walletService');
const { pkrToUsdCents, usdCentsToPkr, PKR_PER_USD, MIN_TOPUP_PKR } = require('../config/currency');

describe('topUpAmountPkr()', () => {
  it('returns the amount checkout stamped, even where the cents round-trip misses it', () => {
    expect(usdCentsToPkr(pkrToUsdCents(5000))).toBe(5001); // the bug, for the record
    expect(WalletService.topUpAmountPkr({ metadata: { amount: '5000' }, amount_total: 1786 })).toBe(5000);
  });

  it('returns the stamped amount for every whole-rupee top-up up to PKR 20,000', () => {
    for (let pkr = MIN_TOPUP_PKR; pkr <= 20000; pkr += 1) {
      expect(WalletService.topUpAmountPkr({ metadata: { amount: String(pkr) }, amount_total: pkrToUsdCents(pkr) })).toBe(pkr);
    }
  });

  it('converts the cents when the session carries no usable stamp', () => {
    expect(WalletService.topUpAmountPkr({ metadata: {}, amount_total: 1786 })).toBe(5001);
    expect(WalletService.topUpAmountPkr({ metadata: { amount: 'abc' }, amount_total: 1786 })).toBe(5001);
    expect(WalletService.topUpAmountPkr({ amount_total: 1000 })).toBe(2800);
  });

  it('converts the cents when the charge is not what the stamp prices to', () => {
    // e.g. a session whose metadata was edited after it was priced
    expect(WalletService.topUpAmountPkr({ metadata: { amount: '50000' }, amount_total: 1786 })).toBe(5001);
  });
});

const hasDb = !!process.env.MONGODB_URI;
const d = hasDb ? describe : describe.skip;
jest.setTimeout(30000);

d('applyTopUp() (real MongoDB)', () => {
  let ownerId;
  let seq = 0;

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  beforeEach(() => {
    ownerId = new mongoose.Types.ObjectId();
  });

  afterEach(async () => {
    const wallets = await Wallet.find({ owner: ownerId });
    await WalletTransaction.deleteMany({ wallet: { $in: wallets.map((w) => w._id) } });
    await Wallet.deleteMany({ owner: ownerId });
  });

  /** What the top-up endpoint does: price the session and pre-create the pending row. */
  async function openCheckout(pkr) {
    seq += 1;
    const sessionId = `cs_test_${ownerId}_${seq}`;
    const wallet = await WalletService.getOrCreateWallet(ownerId, 'User');
    const usdCents = pkrToUsdCents(pkr);
    await WalletTransaction.create({
      wallet: wallet._id,
      type: 'credit',
      amount: pkr,
      description: 'Stripe wallet top-up',
      source: 'stripe_topup',
      status: 'pending',
      stripeSessionId: sessionId,
      metadata: { stripeSessionId: sessionId, originalAmountUsdCents: usdCents, fxRate: PKR_PER_USD },
    });
    return {
      id: sessionId,
      payment_intent: `pi_${seq}`,
      amount_total: usdCents,
      metadata: { ownerId: String(ownerId), ownerType: 'User', amount: String(pkr) },
    };
  }

  const pay = (amount) =>
    WalletService.payWithSettle({
      payerType: 'User',
      payerId: ownerId,
      amount,
      source: 'shopping_payment',
      relatedTo: { kind: 'OrderGroup', id: new mongoose.Types.ObjectId() },
      description: 'Test order',
    });

  async function ledgerNet() {
    const wallet = await Wallet.findOne({ owner: ownerId, ownerType: 'User' });
    const rows = await WalletTransaction.find({ wallet: wallet._id, status: 'completed' });
    return rows.reduce((s, r) => s + (r.type === 'credit' ? r.amount : -r.amount), 0);
  }

  it('top up 5,000, pay 2,500 twice: the wallet is empty and agrees with its history', async () => {
    const session = await openCheckout(5000);
    const { wallet, transaction } = await WalletService.applyTopUp(session);
    expect(wallet.balance).toBe(5000);
    expect(transaction.amount).toBe(5000);
    expect(transaction.status).toBe('completed');

    await pay(2500);
    await pay(2500);

    const after = await Wallet.findOne({ owner: ownerId, ownerType: 'User' });
    expect(after.balance).toBe(0);
    expect(await ledgerNet()).toBe(0);
  });

  it('a retried webhook credits once', async () => {
    const session = await openCheckout(150);
    await WalletService.applyTopUp(session);
    await WalletService.applyTopUp(session);
    const wallet = await Wallet.findOne({ owner: ownerId, ownerType: 'User' });
    expect(wallet.balance).toBe(150);
    expect(await WalletTransaction.countDocuments({ wallet: wallet._id, source: 'stripe_topup' })).toBe(1);
  });

  it('a session without a stamp is credited the converted cents, and the history row says the same', async () => {
    const session = await openCheckout(5000);
    delete session.metadata.amount;
    const { wallet, transaction } = await WalletService.applyTopUp(session);
    expect(wallet.balance).toBe(5001);
    expect(transaction.amount).toBe(5001);
    expect(await ledgerNet()).toBe(wallet.balance);
  });

  it('a top-up with no pre-created row still credits the stamped amount', async () => {
    seq += 1;
    const session = {
      id: `cs_test_${ownerId}_${seq}`,
      payment_intent: `pi_${seq}`,
      amount_total: pkrToUsdCents(2500),
      metadata: { ownerId: String(ownerId), ownerType: 'User', amount: '2500' },
    };
    const { wallet, transaction } = await WalletService.applyTopUp(session);
    expect(wallet.balance).toBe(2500);
    expect(transaction.amount).toBe(2500);
  });
});
