jest.mock('../models/ShoppingNotification', () => ({ create: jest.fn(async (d) => d) }));
jest.mock('../models/Brand', () => ({
  findById: jest.fn(() => ({ select: () => ({ lean: async () => ({ owner: 'vendor1', name: 'Gul Ahmed' }) }) })),
}));
jest.mock('../../../sockets', () => ({ pushToUser: jest.fn().mockResolvedValue(true) }));

const ShoppingNotification = require('../models/ShoppingNotification');
const { pushToUser } = require('../../../sockets');
const n = require('../services/orderNotifications');

const order = {
  _id: 'o1',
  odexId: 'O-1001',
  userId: 'cust1',
  brandId: 'b1',
  total: 4500,
  paymentStatus: 'paid',
  paymentMethod: 'wallet',
  items: [{ quantity: 2 }, { quantity: 1 }],
  trackingNumber: 'TCS-77',
};

beforeEach(() => jest.clearAllMocks());

describe('order transition notifications', () => {
  it.each([
    ['confirmed', 'vendor', 'Order confirmed'],
    ['shipped', 'vendor', 'Your order is on its way'],
    ['out_for_delivery', 'vendor', 'Out for delivery'],
    ['delivered', 'vendor', 'Delivered'],
    ['returned', 'vendor', 'Return accepted'],
    ['refunded', 'admin', 'Refund issued'],
  ])('%s (by %s) → customer hears "%s"', async (status, role, title) => {
    await n.announceOrderTransition(order, status, { role });
    expect(ShoppingNotification.create).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: 'cust1', recipientRole: 'user', title })
    );
    expect(pushToUser).toHaveBeenCalledWith('cust1', 'user', expect.objectContaining({ type: 'order_update', title }));
  });

  it('shipping names the tracking number', () => {
    expect(n.customerMessageFor(order, 'shipped', { role: 'vendor' }).message).toMatch(/TCS-77/);
  });

  it('a store cancellation tells the customer about the refund; the vendor is not told about their own action', async () => {
    await n.announceOrderTransition(order, 'cancelled', { role: 'vendor' });
    const rows = ShoppingNotification.create.mock.calls.map((c) => c[0]);
    expect(rows.map((r) => r.recipient)).toEqual(['cust1']);
    expect(rows[0].message).toMatch(/cancelled by the store; Rs\. 4,500 is refunded/);
  });

  it('a customer cancellation tells the vendor, not the customer', async () => {
    await n.announceOrderTransition(order, 'cancelled', { role: 'customer' });
    const rows = ShoppingNotification.create.mock.calls.map((c) => c[0]);
    expect(rows.map((r) => `${r.recipientRole}:${r.recipient}`)).toEqual(['vendor:vendor1']);
    expect(pushToUser).toHaveBeenCalledWith('vendor1', 'provider', expect.objectContaining({ type: 'order_update' }));
  });

  it('internal steps are not news', async () => {
    await n.announceOrderTransition(order, 'processing', { role: 'vendor' });
    expect(ShoppingNotification.create).not.toHaveBeenCalled();
  });

  it('never throws, even when everything fails', async () => {
    ShoppingNotification.create.mockRejectedValueOnce(new Error('db down'));
    pushToUser.mockRejectedValueOnce(new Error('realtime down'));
    await expect(n.announceOrderTransition(order, 'shipped', { role: 'vendor' })).resolves.toBeUndefined();
  });
});

describe('checkout and returns', () => {
  it('each brand owner is pushed about the new order; the customer gets a receipt without a push', async () => {
    await n.announceOrdersPlaced([order], { _id: 'cust1' });
    const rows = ShoppingNotification.create.mock.calls.map((c) => c[0]);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recipient: 'vendor1', type: 'order_created', message: expect.stringMatching(/3 items, Rs\. 4,500 \(paid\)/) }),
        expect.objectContaining({ recipient: 'cust1', type: 'order_placed' }),
      ])
    );
    expect(pushToUser).toHaveBeenCalledTimes(1);
    expect(pushToUser).toHaveBeenCalledWith('vendor1', 'provider', expect.objectContaining({ type: 'order_created' }));
  });

  it('a return request reaches the vendor', async () => {
    await n.announceReturnRequested({ _id: 'r1', refundAmount: 1500 }, order);
    expect(pushToUser).toHaveBeenCalledWith('vendor1', 'provider', expect.objectContaining({ type: 'return_update' }));
  });
});
