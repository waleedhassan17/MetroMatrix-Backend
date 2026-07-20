/**
 * payoutVendor / reverseVendorPayout — proves the vendor-earnings leg is
 * wired to WalletService.settlePayout() / reversePayout() (Part C.3) via
 * the delivered/refunded transitions, with commissionRate from settings and
 * relatedTo the order.
 */
jest.mock('../../../services/walletService', () => ({
  getOrCreateWallet: jest.fn(),
  recordTransaction: jest.fn(),
  settlePayout: jest.fn(),
  reversePayout: jest.fn(),
}));
jest.mock('../models/Brand', () => ({ findById: jest.fn() }));
jest.mock('../models/Product', () => ({ updateOne: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Order', () => ({ find: jest.fn().mockResolvedValue([]) }));
jest.mock('../models/OrderGroup', () => ({ findById: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/settingsService', () => ({
  getShoppingSettings: jest.fn().mockResolvedValue({ commissionPercent: 8 }),
}));

const WalletService = require('../../../services/walletService');
const Brand = require('../models/Brand');
const { transition } = require('../services/orderService');

beforeEach(() => jest.clearAllMocks());

function makeOrder(status, over = {}) {
  return {
    _id: 'order-1',
    odexId: 'OD-1',
    brandId: 'brand-1',
    orderGroup: 'group-1',
    orderStatus: status,
    paymentStatus: 'paid',
    total: 5000,
    items: [],
    statusHistory: [],
    vendorPayout: null,
    save: jest.fn().mockResolvedValue(true),
    ...over,
  };
}

describe('payoutVendor (on delivered)', () => {
  it('settles the vendor payout with commissionRate and relatedTo the order', async () => {
    Brand.findById.mockResolvedValue({ owner: 'vendor-1' });
    WalletService.settlePayout.mockResolvedValue({
      payeeTransaction: { _id: 'tx-1', amount: 4600 },
      commission: 400,
    });

    const order = makeOrder('out_for_delivery');
    await transition(order, 'delivered', { id: 'vendor-1', role: 'vendor' });

    expect(WalletService.settlePayout).toHaveBeenCalledWith(
      expect.objectContaining({
        payeeType: 'Provider',
        payeeId: 'vendor-1',
        amount: 5000,
        source: 'shopping_earning',
        commissionRate: 8,
        relatedTo: { kind: 'Order', id: 'order-1' },
      })
    );
    expect(order.vendorPayout).toEqual(
      expect.objectContaining({ amount: 4600, commission: 400, walletTransactionId: 'tx-1' })
    );
  });

  it('skips admin-owned brands (no owner → no payout ledger)', async () => {
    Brand.findById.mockResolvedValue({ owner: null });
    const order = makeOrder('out_for_delivery');
    await transition(order, 'delivered', { id: 'admin-1', role: 'admin' });
    expect(WalletService.settlePayout).not.toHaveBeenCalled();
  });
});

describe('reverseVendorPayout (on refunded)', () => {
  it('calls WalletService.reversePayout for an already-paid-out order', async () => {
    Brand.findById.mockResolvedValue({ owner: 'vendor-1' });
    WalletService.getOrCreateWallet.mockResolvedValue({
      _id: 'cust-wallet-1',
      credit: jest.fn().mockResolvedValue(true),
    });
    const order = makeOrder('returned', {
      vendorPayout: { amount: 4600, commission: 400, paidAt: new Date() },
    });
    await transition(order, 'refunded', { id: 'admin-1', role: 'admin' });

    expect(WalletService.reversePayout).toHaveBeenCalledWith({
      payeeType: 'Provider',
      payeeId: 'vendor-1',
      relatedTo: { kind: 'Order', id: 'order-1' },
    });
    expect(order.vendorPayout.paidAt).toBeNull();
  });

  it('does nothing if the vendor was never paid out', async () => {
    const order = makeOrder('returned', { vendorPayout: null, paymentStatus: 'unpaid' });
    await transition(order, 'refunded', { id: 'admin-1', role: 'admin' });
    expect(WalletService.reversePayout).not.toHaveBeenCalled();
  });
});
