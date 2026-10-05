/**
 * settleCompletedAppointment — proves the doctor-payout leg is wired to
 * WalletService.settlePayout() (Part C.3) with the full fee to the doctor (there
 * is no platform commission) and relatedTo the appointment.
 */
jest.mock('../../../services/walletService', () => ({
  getOrCreateWallet: jest.fn(),
  recordTransaction: jest.fn(),
  settlePayout: jest.fn(),
}));
jest.mock('../models/Doctor', () => ({ findById: jest.fn() }));

const WalletService = require('../../../services/walletService');
const Doctor = require('../models/Doctor');
const { settleCompletedAppointment } = require('../services/paymentService');

beforeEach(() => jest.clearAllMocks());

function makeAppointment(over = {}) {
  return {
    _id: 'apt-1',
    doctorId: 'doc-1',
    payout: null,
    payment: { status: 'paid', amount: 2000 },
    save: jest.fn().mockResolvedValue(true),
    ...over,
  };
}

describe('settleCompletedAppointment', () => {
  it('pays the doctor the full fee through settlePayout, relatedTo the appointment', async () => {
    Doctor.findById.mockResolvedValue({ providerId: 'prov-doc-1' });
    WalletService.settlePayout.mockResolvedValue({
      payeeTransaction: { _id: 'tx-1', amount: 2000 },
      commission: 0,
    });

    const apt = makeAppointment();
    await settleCompletedAppointment(apt);

    expect(WalletService.settlePayout).toHaveBeenCalledWith(
      expect.objectContaining({
        payeeType: 'Provider',
        payeeId: 'prov-doc-1',
        amount: 2000,
        source: 'healthcare_earning',
        relatedTo: { kind: 'Appointment', id: 'apt-1' },
      })
    );
    expect(WalletService.settlePayout.mock.calls[0][0].commissionRate).toBeUndefined();
    expect(apt.payout).toEqual({
      amount: 2000,
      commission: 0,
      paidAt: expect.any(Date),
      walletTransactionId: 'tx-1',
    });
    expect(apt.save).toHaveBeenCalled();
  });

  it('is idempotent: already-settled appointments are skipped', async () => {
    const apt = makeAppointment({ payout: { paidAt: new Date() } });
    await settleCompletedAppointment(apt);
    expect(WalletService.settlePayout).not.toHaveBeenCalled();
  });

  it('does nothing for a zero-amount (free) consultation', async () => {
    const apt = makeAppointment({ payment: { status: 'paid', amount: 0 } });
    await settleCompletedAppointment(apt);
    expect(WalletService.settlePayout).not.toHaveBeenCalled();
  });
});
