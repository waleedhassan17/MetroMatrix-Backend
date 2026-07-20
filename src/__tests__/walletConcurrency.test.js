/**
 * PART B — required concurrency proof, against a REAL MongoDB connection
 * (not mocks): fire 10 simultaneous debits at a wallet that only covers 6.
 * Exactly 6 must succeed, 4 must fail with 'Insufficient balance', and the
 * final balance must be exactly 0 — proving debitAtomic's $inc-with-guard
 * closes the read-modify-write race the old credit()/debit() instance
 * methods had.
 *
 * Needs MONGODB_URI (skips gracefully without one, e.g. in an offline CI
 * runner) — this is deliberately an integration test, not a mock, because
 * the property under test IS MongoDB's atomicity guarantee.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');

const hasDb = !!process.env.MONGODB_URI;
const d = hasDb ? describe : describe.skip;

// Real Atlas round trips (connect + 10 concurrent ops) comfortably exceed
// Jest's 5s default.
jest.setTimeout(30000);

d('Wallet.debitAtomic — concurrency (real MongoDB)', () => {
  let wallet;

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    wallet = await Wallet.create({
      owner: new mongoose.Types.ObjectId(),
      ownerType: 'User',
      balance: 6,
      currency: 'PKR',
    });
  });

  afterAll(async () => {
    await Wallet.deleteOne({ _id: wallet._id });
    await mongoose.disconnect();
  });

  it('10 concurrent 1-unit debits against a balance of 6 → exactly 6 succeed, 4 fail, final balance 0', async () => {
    const attempts = Array.from({ length: 10 }, () =>
      Wallet.debitAtomic(wallet._id, 1).then(
        () => ({ ok: true }),
        (err) => ({ ok: false, message: err.message })
      )
    );
    const results = await Promise.all(attempts);

    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);

    expect(succeeded).toHaveLength(6);
    expect(failed).toHaveLength(4);
    expect(failed.every((r) => r.message === 'Insufficient balance')).toBe(true);

    const finalWallet = await Wallet.findById(wallet._id);
    expect(finalWallet.balance).toBe(0);
  });
});
