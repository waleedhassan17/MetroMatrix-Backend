/**
 * HS4 payment logic — double-payment prevention, insufficient balance,
 * commission arithmetic (wallet + cash paths), review/payout guards.
 * Wallet + models mocked, no DB.
 */
jest.mock('../../../services/walletService', () => ({
  transferFunds: jest.fn(),
  getOrCreateWallet: jest.fn(),
  recordTransaction: jest.fn().mockResolvedValue({ _id: 'txn-1' }),
}));
jest.mock('../../../models/WalletTransaction', () => ({
  aggregate: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/settingsService', () => ({
  getHomeserviceSettings: jest.fn().mockResolvedValue({
    commissionPercent: 10,
    minPayoutAmount: 500,
  }),
}));

const WalletService = require('../../../services/walletService');
const {
  payWithWallet,
  confirmCash,
  assertPayable,
  commissionOf,
  PaymentError,
} = require('../services/paymentService');
const { STATUS } = require('../services/statusMap');

function makeBooking(overrides = {}) {
  return {
    _id: 'bk-1',
    status: STATUS.COMPLETED,
    provider: { _id: 'prov-1' },
    customer: 'cust-1',
    pricing: { estimatedPrice: 2000, finalPrice: null },
    payment: { status: 'unpaid', method: null, requestedAmount: null },
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => jest.clearAllMocks());

describe('assertPayable', () => {
  it('rejects payment before COMPLETED', () => {
    const b = makeBooking({ status: STATUS.IN_PROGRESS });
    expect(() => assertPayable(b)).toThrow(/completed/i);
  });

  it('rejects double payment', () => {
    const b = makeBooking({ payment: { status: 'paid' } });
    expect(() => assertPayable(b)).toThrow(/already been paid/i);
  });
});

describe('commission arithmetic', () => {
  it('10% of 2500 is 250', () => {
    expect(commissionOf(2500, 10)).toBe(250);
  });
  it('rounds to 2 dp', () => {
    expect(commissionOf(999, 7.5)).toBeCloseTo(74.93, 2);
  });
});

describe('wallet payment path', () => {
  it('transfers with commission feePercent and an idempotency key', async () => {
    WalletService.transferFunds.mockResolvedValue({
      senderTransaction: { _id: 'txn-9' },
    });
    const b = makeBooking();
    const { commission } = await payWithWallet(b, { _id: 'cust-1' }, 2000);

    expect(WalletService.transferFunds).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 2000,
        feePercent: 10,
        idempotencyKey: 'hspay-bk-1',
        senderOwnerType: 'User',
        receiverOwnerType: 'Provider',
      })
    );
    expect(commission).toBe(200);
    expect(b.payment.status).toBe('paid');
    expect(b.payment.method).toBe('wallet');
    expect(b.pricing.finalPrice).toBe(2000);
    expect(b.save).toHaveBeenCalled();
  });

  it('surfaces insufficient balance as a clear 400', async () => {
    WalletService.transferFunds.mockRejectedValue(new Error('Insufficient balance'));
    const b = makeBooking();
    const err = await payWithWallet(b, { _id: 'cust-1' }, 2000).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentError);
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/insufficient wallet balance/i);
    expect(b.payment.status).toBe('unpaid');
  });

  it('second payment attempt is rejected before touching the wallet', async () => {
    const b = makeBooking({ payment: { status: 'paid' } });
    await expect(payWithWallet(b, { _id: 'cust-1' }, 2000)).rejects.toThrow(/already/i);
    expect(WalletService.transferFunds).not.toHaveBeenCalled();
  });
});

describe('cash payment path', () => {
  it('debits commission from the provider wallet when balance covers it', async () => {
    const debit = jest.fn().mockResolvedValue(undefined);
    WalletService.getOrCreateWallet.mockResolvedValue({ _id: 'w1', balance: 1000, debit });
    const b = makeBooking({ pricing: { estimatedPrice: 2000, finalPrice: 2000 } });

    const { commission } = await confirmCash(b, { _id: 'prov-1' });

    expect(commission).toBe(200);
    expect(debit).toHaveBeenCalledWith(200);
    expect(WalletService.recordTransaction).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({ type: 'debit', amount: 200, status: 'completed' })
    );
    expect(b.payment.status).toBe('paid');
    expect(b.payment.method).toBe('cash');
  });

  it('records commission as PENDING when the provider wallet cannot cover it', async () => {
    const debit = jest.fn();
    WalletService.getOrCreateWallet.mockResolvedValue({ _id: 'w1', balance: 50, debit });
    const b = makeBooking({ pricing: { estimatedPrice: 2000, finalPrice: 2000 } });

    await confirmCash(b, { _id: 'prov-1' });

    expect(debit).not.toHaveBeenCalled();
    expect(WalletService.recordTransaction).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({ status: 'pending', amount: 200 })
    );
  });

  it('cash confirmation on an already-paid booking is rejected', async () => {
    const b = makeBooking({ payment: { status: 'paid' } });
    await expect(confirmCash(b, { _id: 'prov-1' })).rejects.toThrow(/already/i);
  });
});
