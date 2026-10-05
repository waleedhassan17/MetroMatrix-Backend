/**
 * HS4 payment logic — double-payment prevention, insufficient balance, and
 * the provider being paid in full on both paths (there is no commission).
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

const WalletService = require('../../../services/walletService');
const Booking = require('../models/Booking');
const {
  payWithWallet,
  confirmCash,
  assertPayable,
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

describe('wallet payment path', () => {
  it('settles the full amount to the provider, with relatedTo and an idempotency key', async () => {
    WalletService.settle.mockResolvedValue({ payerTransaction: { _id: 'txn-9' } });
    const b = makeBooking();
    const { transaction } = await payWithWallet(b, { _id: 'cust-1' }, 2000);

    expect(WalletService.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 2000,
        idempotencyKey: 'hspay-bk-1',
        payerType: 'User',
        payeeType: 'Provider',
        source: 'homeservice_payment',
        relatedTo: { kind: 'Booking', id: 'bk-1' },
      })
    );
    // No commission: nothing asks settle() to divert a share.
    expect(WalletService.settle.mock.calls[0][0].commissionRate).toBeUndefined();
    expect(transaction._id).toBe('txn-9');
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
  it('marks the booking paid and moves nothing — the provider keeps all the cash', async () => {
    const b = makeBooking({ pricing: { estimatedPrice: 2000, finalPrice: 2000 } });

    const { transaction } = await confirmCash(b);

    expect(transaction._id).toBe('CASH-bk-1');
    expect(WalletService.settle).not.toHaveBeenCalled();
    expect(WalletService.recordTransaction).not.toHaveBeenCalled();
    expect(b.payment.status).toBe('paid');
    expect(b.payment.method).toBe('cash');
    expect(b.payment.walletTransactionId).toBeNull();
    expect(b.save).toHaveBeenCalled();
  });

  it('cash confirmation on an already-paid booking is rejected', async () => {
    const b = makeBooking({ payment: { status: 'paid' } });
    await expect(confirmCash(b)).rejects.toThrow(/already/i);
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

  it('cash confirmation after the booking was paid elsewhere says so, and changes nothing', async () => {
    Booking.updateOne.mockResolvedValueOnce({ matchedCount: 0 });
    Booking.findById.mockReturnValueOnce(lean({ payment: { status: 'paid' } }));
    const b = makeBooking({ pricing: { estimatedPrice: 2000, finalPrice: 2000 } });
    const err = await confirmCash(b).catch((e) => e);
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/already been paid/i);
    expect(b.save).not.toHaveBeenCalled();
  });

  it('the claim is released when the wallet declines, so the customer can retry', async () => {
    WalletService.settle.mockRejectedValue(new Error('Insufficient balance'));
    const b = makeBooking();
    await payWithWallet(b, { _id: 'cust-1' }, 2000).catch(() => {});
    // claim + release
    expect(Booking.updateOne).toHaveBeenCalledTimes(2);
    expect(Booking.updateOne.mock.calls[1][1]).toEqual({ $set: { 'payment.settlingSince': null } });
  });

  it('the cash bill is the amount the provider requested, not the estimate', async () => {
    const b = makeBooking({
      pricing: { estimatedPrice: 2000, finalPrice: null },
      payment: { status: 'requested', method: 'cash', requestedAmount: 3000 },
    });
    await confirmCash(b);
    expect(b.pricing.finalPrice).toBe(3000);
  });
});
