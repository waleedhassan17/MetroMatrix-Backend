/**
 * settleCompletedAppointment — proves the doctor-payout leg is wired to
 * WalletService.settlePayout() (Part C.3) with the right commissionRate and
 * relatedTo, and that the commission is no longer computed-then-discarded.
 */
jest.mock('../../../services/walletService', () => ({
  getOrCreateWallet: jest.fn(),
  recordTransaction: jest.fn(),
  settlePayout: jest.fn(),
}));
jest.mock('../models/Doctor', () => ({ findById: jest.fn() }));
jest.mock('./../services/settingsService', () => ({
  getHealthcareSettings: jest.fn().mockResolvedValue({ commissionPercent: 15 }),
}));

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
  it('calls settlePayout with the doctor as payee, commissionRate from settings, and relatedTo the appointment', async () => {
    Doctor.findById.mockResolvedValue({ providerId: 'prov-doc-1' });
    WalletService.settlePayout.mockResolvedValue({
      payeeTransaction: { _id: 'tx-1', amount: 1700 },
      commission: 300,
    });

    const apt = makeAppointment();
    await settleCompletedAppointment(apt);

    expect(WalletService.settlePayout).toHaveBeenCalledWith(
      expect.objectContaining({
        payeeType: 'Provider',
        payeeId: 'prov-doc-1',
        amount: 2000,
        source: 'healthcare_earning',
        commissionRate: 15,
        relatedTo: { kind: 'Appointment', id: 'apt-1' },
      })
    );
    expect(apt.payout).toEqual({
      amount: 1700,
      commission: 300,
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
