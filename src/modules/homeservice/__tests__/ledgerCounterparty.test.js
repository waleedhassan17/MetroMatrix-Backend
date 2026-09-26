/**
 * Regression (QA 2026-09-26): a provider confirming a cash payment always got
 * an error, because the commission leg — provider → Platform through
 * WalletService.settle() — wrote a WalletTransaction whose counterparty type
 * was 'Platform', and the model only allowed 'User' | 'Provider'. The
 * validation failure aborted the whole settlement.
 */
const mongoose = require('mongoose');
const WalletTransaction = require('../../../models/WalletTransaction');

describe('WalletTransaction counterparty', () => {
  const base = {
    wallet: new mongoose.Types.ObjectId(),
    type: 'debit',
    amount: 120,
    currency: 'PKR',
    description: 'Platform commission (cash)',
    source: 'commission',
    status: 'completed',
  };

  it('accepts the platform commission ledger as a counterparty', () => {
    const doc = new WalletTransaction({
      ...base,
      counterparty: { id: new mongoose.Types.ObjectId('000000000000000000000001'), type: 'Platform' },
    });
    const err = doc.validateSync();
    expect(err && err.errors['counterparty.type']).toBeUndefined();
  });

  it('still rejects an unknown counterparty type', () => {
    const doc = new WalletTransaction({
      ...base,
      counterparty: { id: new mongoose.Types.ObjectId(), type: 'Nobody' },
    });
    const err = doc.validateSync();
    expect(err && err.errors['counterparty.type']).toBeDefined();
  });
});
