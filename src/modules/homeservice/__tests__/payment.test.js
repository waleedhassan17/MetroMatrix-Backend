/**
 * HS4 payment logic — double-payment prevention, insufficient balance,
 * commission arithmetic (wallet + cash paths), review/payout guards.
 * Wallet + models mocked, no DB.
 */
jest.mock('../../../services/walletService', () => ({
  settle: jest.fn(),
  getOrCreateWallet: jest.fn(),
  recordTransaction: jest.fn().mockResolvedValue({ _id: 'txn-1' }),
  PLATFORM_OWNER_ID: 'platform-1',
}));
jest.mock('../../../models/WalletTransaction', () => ({
  aggregate: jest.fn().mockResolvedValue([]),
}));
// The settlement claim is a conditional update on the booking; by default it
// succeeds (one document matched). Individual tests override it to simulate a
// rival settlement already holding the claim.
jest.mock('../models/Booking', () => ({
  updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
  findById: jest.fn(),
}));
jest.mock('../services/settingsService', () => ({
  getHomeserviceSettings: jest.fn().mockResolvedValue({
    commissionPercent: 10,
    minPayoutAmount: 500,
  }),
}));

const WalletService = require('../../../services/walletService');
const Booking = require('../models/Booking');
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

beforeEach(() => {
  jest.clearAllMocks();
  Booking.updateOne.mockResolvedValue({ matchedCount: 1 });
});

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
  it('settles with commissionRate, relatedTo and an idempotency key', async () => {
    WalletService.settle.mockResolvedValue({
      payerTransaction: { _id: 'txn-9' },
      commission: 200,
    });
    const b = makeBooking();
    const { commission } = await payWithWallet(b, { _id: 'cust-1' }, 2000);

    expect(WalletService.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 2000,
        commissionRate: 10,
        idempotencyKey: 'hspay-bk-1',
        payerType: 'User',
        payeeType: 'Provider',
        source: 'homeservice_payment',
        relatedTo: { kind: 'Booking', id: 'bk-1' },
      })
    );
    expect(commission).toBe(200);
    expect(b.payment.status).toBe('paid');
    expect(b.payment.method).toBe('wallet');
    expect(b.pricing.finalPrice).toBe(2000);
    expect(b.save).toHaveBeenCalled();
  });

  it('surfaces insufficient balance as a clear 400', async () => {
    WalletService.settle.mockRejectedValue(new Error('Insufficient balance'));
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
    expect(WalletService.settle).not.toHaveBeenCalled();
  });
});

describe('cash payment path', () => {
  it('settles the commission (provider→Platform) when balance covers it', async () => {
    WalletService.getOrCreateWallet.mockResolvedValue({ _id: 'w1', balance: 1000 });
    WalletService.settle.mockResolvedValue({ payerTransaction: { _id: 'txn-commission' } });
    const b = makeBooking({ pricing: { estimatedPrice: 2000, finalPrice: 2000 } });

    const { commission } = await confirmCash(b, { _id: 'prov-1' });

    expect(commission).toBe(200);
    expect(WalletService.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        payerType: 'Provider',
        payerId: 'prov-1',
        payeeType: 'Platform',
        amount: 200,
        source: 'commission',
        commissionRate: 0,
        relatedTo: { kind: 'Booking', id: 'bk-1' },
      })
    );
    expect(b.payment.status).toBe('paid');
    expect(b.payment.method).toBe('cash');
    expect(b.payment.walletTransactionId).toBe('txn-commission');
  });

  it('records commission as PENDING (no settle() call) when the provider wallet cannot cover it', async () => {
    WalletService.getOrCreateWallet.mockResolvedValue({ _id: 'w1', balance: 50 });
    const b = makeBooking({ pricing: { estimatedPrice: 2000, finalPrice: 2000 } });

    await confirmCash(b, { _id: 'prov-1' });

    expect(WalletService.settle).not.toHaveBeenCalled();
    expect(WalletService.recordTransaction).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({ status: 'pending', amount: 200, source: 'commission' })
    );
  });

  it('cash confirmation on an already-paid booking is rejected', async () => {
    const b = makeBooking({ payment: { status: 'paid' } });
    await expect(confirmCash(b, { _id: 'prov-1' })).rejects.toThrow(/already/i);
  });
});

describe('one settlement per booking (wallet vs cash race)', () => {
  const lean = (value) => ({ select: () => ({ lean: () => Promise.resolve(value) }) });

  it('a wallet payment refuses to move money while another settlement holds the claim', async () => {
    Booking.updateOne.mockResolvedValueOnce({ matchedCount: 0 });
    Booking.findById.mockReturnValueOnce(lean({ payment: { status: 'requested' } }));
    const b = makeBooking();
    const err = await payWithWallet(b, { _id: 'cust-1' }, 2000).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentError);
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/already being processed/i);
    expect(WalletService.settle).not.toHaveBeenCalled();
  });

  it('cash confirmation after the booking was paid elsewhere says so, and moves nothing', async () => {
    WalletService.getOrCreateWallet.mockResolvedValue({ _id: 'w1', balance: 1000 });
    Booking.updateOne.mockResolvedValueOnce({ matchedCount: 0 });
    Booking.findById.mockReturnValueOnce(lean({ payment: { status: 'paid' } }));
    const b = makeBooking({ pricing: { estimatedPrice: 2000, finalPrice: 2000 } });
    const err = await confirmCash(b, { _id: 'prov-1' }).catch((e) => e);
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/already been paid/i);
    expect(WalletService.settle).not.toHaveBeenCalled();
    expect(WalletService.recordTransaction).not.toHaveBeenCalled();
  });

  it('the claim is released when the wallet declines, so the customer can retry', async () => {
    WalletService.settle.mockRejectedValue(new Error('Insufficient balance'));
    const b = makeBooking();
    await payWithWallet(b, { _id: 'cust-1' }, 2000).catch(() => {});
    // claim + release
    expect(Booking.updateOne).toHaveBeenCalledTimes(2);
    expect(Booking.updateOne.mock.calls[1][1]).toEqual({ $set: { 'payment.settlingSince': null } });
  });

  it('cash commission is idempotent per booking', async () => {
    WalletService.getOrCreateWallet.mockResolvedValue({ _id: 'w1', balance: 1000 });
    WalletService.settle.mockResolvedValue({ payerTransaction: { _id: 'txn-commission' } });
    const b = makeBooking({ pricing: { estimatedPrice: 2000, finalPrice: 2000 } });
    await confirmCash(b, { _id: 'prov-1' });
    expect(WalletService.settle).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'hscash-bk-1' })
    );
  });

  it('the cash bill is the amount the provider requested, not the estimate', async () => {
    WalletService.getOrCreateWallet.mockResolvedValue({ _id: 'w1', balance: 1000 });
    WalletService.settle.mockResolvedValue({ payerTransaction: { _id: 'txn-commission' } });
    const b = makeBooking({
      pricing: { estimatedPrice: 2000, finalPrice: 3000 },
      payment: { status: 'requested', method: 'cash', requestedAmount: 3000 },
    });
    const { commission } = await confirmCash(b, { _id: 'prov-1' });
    expect(commission).toBe(300);
  });
});
