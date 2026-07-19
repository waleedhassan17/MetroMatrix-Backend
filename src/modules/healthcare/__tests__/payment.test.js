/**
 * H2 payment logic — refund windows, commission arithmetic, double-payment
 * prevention and insufficient balance (wallet mocked, no DB).
 */
jest.mock('../../../services/walletService', () => ({
  getOrCreateWallet: jest.fn(),
  recordTransaction: jest.fn().mockResolvedValue({ _id: 'txn1' }),
}));
jest.mock('../models/Doctor', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Appointment', () => ({}));
jest.mock('./../services/settingsService', () => ({
  getHealthcareSettings: jest.fn().mockResolvedValue({
    commissionPercent: 10,
    cancellationWindowHours: 12,
    lateCancelRefundPercent: 50,
  }),
}));

const WalletService = require('../../../services/walletService');
const {
  computeRefundAmount,
  computePayout,
  payAppointment,
  PaymentError,
} = require('../services/paymentService');

const SETTINGS = { cancellationWindowHours: 12, lateCancelRefundPercent: 50 };
const HOUR = 3600000;
const now = new Date('2026-07-19T12:00:00Z');

describe('computeRefundAmount — cancellation window boundaries', () => {
  const base = { amountPaid: 2000, now, cancelledBy: 'patient' };

  it('cancelling exactly AT the window boundary → full refund', () => {
    const slotStart = new Date(now.getTime() + 12 * HOUR);
    expect(computeRefundAmount({ ...base, slotStart }, SETTINGS)).toBe(2000);
  });

  it('cancelling just INSIDE the window → partial refund (50%)', () => {
    const slotStart = new Date(now.getTime() + 12 * HOUR - 60000);
    expect(computeRefundAmount({ ...base, slotStart }, SETTINGS)).toBe(1000);
  });

  it('cancelling well before → full refund', () => {
    const slotStart = new Date(now.getTime() + 48 * HOUR);
    expect(computeRefundAmount({ ...base, slotStart }, SETTINGS)).toBe(2000);
  });

  it('doctor cancels → always full refund even inside window', () => {
    const slotStart = new Date(now.getTime() + 1 * HOUR);
    expect(
      computeRefundAmount({ ...base, slotStart, cancelledBy: 'doctor' }, SETTINGS)
    ).toBe(2000);
  });

  it('forfeit policy (0%) inside window', () => {
    const slotStart = new Date(now.getTime() + 1 * HOUR);
    expect(
      computeRefundAmount({ ...base, slotStart }, { cancellationWindowHours: 12, lateCancelRefundPercent: 0 })
    ).toBe(0);
  });

  it('nothing paid → nothing refunded', () => {
    expect(
      computeRefundAmount({ amountPaid: 0, slotStart: now, now, cancelledBy: 'patient' }, SETTINGS)
    ).toBe(0);
  });
});

describe('computePayout — commission arithmetic', () => {
  it('10% of 2000 → 200 commission, 1800 payout', () => {
    expect(computePayout(2000, 10)).toEqual({ commission: 200, payout: 1800 });
  });
  it('rounds commission and reconciles exactly', () => {
    const { commission, payout } = computePayout(999, 10);
    expect(commission + payout).toBe(999);
  });
  it('0% commission passes everything through', () => {
    expect(computePayout(1500, 0)).toEqual({ commission: 0, payout: 1500 });
  });
});

describe('payAppointment', () => {
  const makeAppointment = (over = {}) => ({
    _id: 'apt1',
    status: 'pending',
    totalAmount: 2000,
    payment: {
      status: 'unpaid',
      method: null,
      amount: 2000,
      toObject() { return { ...this }; },
      ...over.payment,
    },
    save: jest.fn().mockResolvedValue(true),
    ...over,
  });
  const user = { _id: 'patient1' };

  it('rejects a second payment (double-payment prevention)', async () => {
    const apt = makeAppointment({ payment: { status: 'paid', amount: 2000 } });
    await expect(payAppointment(apt, user, 'wallet')).rejects.toThrow(/already paid/i);
  });

  it('rejects insufficient wallet balance with a clear 400', async () => {
    WalletService.getOrCreateWallet.mockResolvedValue({ balance: 500, debit: jest.fn() });
    const apt = makeAppointment();
    await expect(payAppointment(apt, user, 'wallet')).rejects.toThrow(/Insufficient wallet balance/);
    try {
      await payAppointment(makeAppointment(), user, 'wallet');
    } catch (e) {
      expect(e).toBeInstanceOf(PaymentError);
      expect(e.statusCode).toBe(400);
    }
  });

  it('debits the wallet and marks paid on success', async () => {
    const debit = jest.fn().mockResolvedValue(true);
    WalletService.getOrCreateWallet.mockResolvedValue({ _id: 'w1', balance: 5000, debit });
    const apt = makeAppointment();
    await payAppointment(apt, user, 'wallet');
    expect(debit).toHaveBeenCalledWith(2000);
    expect(apt.payment.status).toBe('paid');
    expect(apt.payment.method).toBe('wallet');
    expect(apt.save).toHaveBeenCalled();
  });

  it('cash_at_clinic stays unpaid but records the method', async () => {
    const apt = makeAppointment();
    await payAppointment(apt, user, 'cash_at_clinic');
    expect(apt.payment.status).toBe('unpaid');
    expect(apt.payment.method).toBe('cash_at_clinic');
  });

  it('rejects payment on a cancelled appointment', async () => {
    const apt = makeAppointment({ status: 'cancelled' });
    await expect(payAppointment(apt, user, 'wallet')).rejects.toThrow(/cancelled/);
  });

  it('rejects an unknown method', async () => {
    await expect(payAppointment(makeAppointment(), user, 'bitcoin')).rejects.toThrow(/method/);
  });
});
