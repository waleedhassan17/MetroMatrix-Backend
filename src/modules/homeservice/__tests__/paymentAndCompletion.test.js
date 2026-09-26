/**
 * The server owns the price (QA 2026-09-26):
 *   - POST /payments/process charges the bill, never the phone's `amount`
 *     (a customer could settle a Rs. 2,000 job for Rs. 1), and choosing cash
 *     never overwrites what the provider asked for.
 *   - POST /provider/jobs/:id/complete validates the final amount and locks
 *     it once paid.
 * Models, wallet and realtime are mocked — no DB, no network.
 */
jest.mock('../models/Booking', () => ({ findById: jest.fn() }));
jest.mock('../services/paymentService', () => {
  class PaymentError extends Error {
    constructor(message, statusCode = 400) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return {
    PaymentError,
    payWithWallet: jest.fn(),
    confirmCash: jest.fn(),
    assertPayable: jest.fn((b) => {
      if (b.payment.status === 'paid') throw new PaymentError('This booking has already been paid');
    }),
    pendingCommission: jest.fn().mockResolvedValue(0),
  };
});
jest.mock('../../../services/walletService', () => ({
  getOrCreateWallet: jest.fn().mockResolvedValue({ _id: 'w1', balance: 5000 }),
}));
jest.mock('../../../sockets', () => ({
  emitToBooking: jest.fn().mockResolvedValue(true),
  emitToUser: jest.fn().mockResolvedValue(true),
  pushToUser: jest.fn().mockResolvedValue(true),
}));
jest.mock('../services/notificationService', () => ({
  notifyPaymentReceived: jest.fn().mockResolvedValue(null),
  notifyPaymentRequested: jest.fn().mockResolvedValue(null),
  notifyCashSelected: jest.fn().mockResolvedValue(null),
  notifyCashConfirmed: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/bookingService', () => ({
  transition: jest.fn(async (b, status) => {
    b.status = status;
    return b;
  }),
  releaseCompetingRequests: jest.fn().mockResolvedValue([]),
}));

const Booking = require('../models/Booking');
const { payWithWallet } = require('../services/paymentService');
const { pushToUser } = require('../../../sockets');
const { transition } = require('../services/bookingService');
const { processPayment, requestPayment } = require('../controllers/paymentController');
const { completeJob } = require('../controllers/jobController');
const { STATUS } = require('../services/statusMap');

const BOOKING_ID = '64b7f0a1c2d3e4f5a6b7c8d9';
const CUSTOMER_ID = '64b7f0a1c2d3e4f5a6b7c8aa';
const PROVIDER_ID = '64b7f0a1c2d3e4f5a6b7c8bb';

function makeBooking(overrides = {}) {
  return {
    _id: BOOKING_ID,
    status: STATUS.COMPLETED,
    customer: { _id: CUSTOMER_ID, fullName: 'Sarah Malik' },
    provider: { _id: PROVIDER_ID, fullName: 'Ahmad Khan', profilePhoto: null },
    serviceCategory: 'electricians',
    serviceSubCategory: 'Electrician',
    pricing: { estimatedPrice: 500, finalPrice: 2000 },
    payment: { status: 'unpaid', method: null, requestedAmount: null },
    work: {},
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function withBooking(doc) {
  Booking.findById.mockReturnValue({
    populate: () => ({ populate: () => Promise.resolve(doc) }),
  });
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function call(handler, req) {
  const res = mockRes();
  let error = null;
  await handler(req, res, (e) => {
    error = e || null;
  });
  return { res, error, status: res.statusCode };
}

const customerReq = (body) => ({
  body,
  user: { _id: CUSTOMER_ID, fullName: 'Sarah Malik' },
});

beforeEach(() => {
  jest.clearAllMocks();
  payWithWallet.mockImplementation(async (b) => {
    b.payment.status = 'paid';
    b.payment.method = 'wallet';
    b.payment.paidAt = new Date();
    return { transaction: { _id: 'tx-1' }, commission: 200 };
  });
});

describe('POST /payments/process — the bill is the server\'s', () => {
  it('refuses an amount that differs from the bill (409) and moves no money', async () => {
    withBooking(makeBooking());
    const { error, status } = await call(processPayment, customerReq({ bookingId: BOOKING_ID, method: 'wallet', amount: 1 }));
    expect(status).toBe(409);
    expect(error.message).toMatch(/Rs\. 2,000/);
    expect(payWithWallet).not.toHaveBeenCalled();
  });

  it('charges the bill, not whatever the phone sent', async () => {
    const b = makeBooking({ payment: { status: 'requested', method: null, requestedAmount: 2400 } });
    withBooking(b);
    const { res, error } = await call(processPayment, customerReq({ bookingId: BOOKING_ID, method: 'wallet', amount: 2400 }));
    expect(error).toBeNull();
    expect(payWithWallet).toHaveBeenCalledWith(b, expect.anything(), 2400);
    expect(res.body.data).toMatchObject({ status: 'completed', amount: 2400, method: 'wallet' });
  });

  it('with no amount sent, still charges exactly the bill', async () => {
    const b = makeBooking();
    withBooking(b);
    await call(processPayment, customerReq({ bookingId: BOOKING_ID, method: 'wallet' }));
    expect(payWithWallet).toHaveBeenCalledWith(b, expect.anything(), 2000);
  });

  it('older builds\' "jazzcash" is the wallet it always was', async () => {
    withBooking(makeBooking());
    const { error } = await call(processPayment, customerReq({ bookingId: BOOKING_ID, method: 'jazzcash' }));
    expect(error).toBeNull();
    expect(payWithWallet).toHaveBeenCalled();
  });

  it('an unknown method is a 400, not a wallet charge', async () => {
    withBooking(makeBooking());
    const { status } = await call(processPayment, customerReq({ bookingId: BOOKING_ID, method: 'bitcoin' }));
    expect(status).toBe(400);
    expect(payWithWallet).not.toHaveBeenCalled();
  });

  it('choosing cash never overwrites the amount the provider requested', async () => {
    const b = makeBooking({ payment: { status: 'requested', method: null, requestedAmount: 1800 } });
    withBooking(b);
    const { res } = await call(processPayment, customerReq({ bookingId: BOOKING_ID, method: 'cash' }));
    expect(b.payment.requestedAmount).toBe(1800);
    expect(b.payment.method).toBe('cash');
    expect(res.body.data).toMatchObject({ status: 'pending', amount: 1800, method: 'cash' });
    // and the provider is told to expect cash
    expect(pushToUser).toHaveBeenCalledWith(PROVIDER_ID, 'provider', expect.objectContaining({ type: 'payment_update' }));
  });

  it('only the booking\'s customer may pay', async () => {
    withBooking(makeBooking());
    const { status } = await call(processPayment, {
      body: { bookingId: BOOKING_ID, method: 'wallet' },
      user: { _id: '64b7f0a1c2d3e4f5a6b7c8cc' },
    });
    expect(status).toBe(403);
  });

  it('a malformed booking id is a 400, not a crash', async () => {
    const { status } = await call(processPayment, customerReq({ bookingId: 'nope', method: 'wallet' }));
    expect(status).toBe(400);
  });
});

describe('POST /provider/jobs/:id/request-payment', () => {
  it('rejects a negative amount', async () => {
    const b = makeBooking();
    const { status } = await call(requestPayment, { booking: b, body: { amount: -100 }, user: { _id: PROVIDER_ID } });
    expect(status).toBe(400);
    expect(b.save).not.toHaveBeenCalled();
  });

  it('records the request, keeps price and request together, and tells the customer', async () => {
    const b = makeBooking();
    const { res } = await call(requestPayment, { booking: b, body: { amount: '2500' }, user: { _id: PROVIDER_ID } });
    expect(b.payment).toMatchObject({ status: 'requested', requestedAmount: 2500 });
    expect(b.pricing.finalPrice).toBe(2500);
    expect(res.body.data.amount).toBe(2500);
    expect(pushToUser).toHaveBeenCalledWith(CUSTOMER_ID, 'user', expect.objectContaining({ type: 'payment_requested' }));
  });
});

describe('POST /provider/jobs/:id/complete — final amount', () => {
  const providerReq = (booking, body) => ({ booking, body, user: { _id: PROVIDER_ID } });

  it('a negative final amount is refused before anything changes', async () => {
    const b = makeBooking({ status: STATUS.IN_PROGRESS, pricing: { estimatedPrice: 500, finalPrice: null } });
    const { status, error } = await call(completeJob, providerReq(b, { finalAmount: -500 }));
    expect(status).toBe(400);
    expect(error.message).toMatch(/above zero/);
    expect(transition).not.toHaveBeenCalled();
    expect(b.pricing.finalPrice).toBeNull();
  });

  it('completes with a valid amount in the same write as the status change', async () => {
    const b = makeBooking({ status: STATUS.IN_PROGRESS, pricing: { estimatedPrice: 500, finalPrice: null } });
    const { res } = await call(completeJob, providerReq(b, { finalAmount: '1500' }));
    expect(b.pricing.finalPrice).toBe(1500);
    expect(transition).toHaveBeenCalledWith(b, STATUS.COMPLETED, expect.objectContaining({ role: 'provider' }));
    expect(res.body.data.finalAmount).toBe(1500);
  });

  it('the price is locked once the customer has paid (409)', async () => {
    const b = makeBooking({ payment: { status: 'paid', method: 'wallet', requestedAmount: null } });
    const { status } = await call(completeJob, providerReq(b, { finalAmount: 99 }));
    expect(status).toBe(409);
    expect(b.pricing.finalPrice).toBe(2000);
  });

  it('an open payment request follows a corrected price', async () => {
    const b = makeBooking({ payment: { status: 'requested', method: null, requestedAmount: 2000 } });
    await call(completeJob, providerReq(b, { finalAmount: 1700 }));
    expect(b.payment.requestedAmount).toBe(1700);
    expect(b.save).toHaveBeenCalled();
  });
});
