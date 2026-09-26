const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const WalletService = require('../../../services/walletService');
const {
  payWithWallet,
  confirmCash,
  assertPayable,
  PaymentError,
} = require('../services/paymentService');
const { billOf, parseProviderAmount, AmountError } = require('../services/money');
const { avatar } = require('../services/serializers');

const ok = (res, data, message) => res.json({ success: true, data, message });

const rupees = (n) => `Rs. ${Math.round(Number(n) || 0).toLocaleString('en-PK')}`;

/**
 * The two ways a home-service job is actually settled. 'jazzcash' and
 * 'easypaisa' were once offered as separate methods, but both only ever
 * debited the in-app wallet under another brand's name, so they are accepted
 * from older app builds and treated as what they always were: the wallet.
 */
function normalizeMethod(method) {
  if (method === 'cash') return 'cash';
  if (['wallet', 'jazzcash', 'easypaisa'].includes(method)) return 'wallet';
  return null;
}

/** Run best-effort side effects side by side; the payment is already settled. */
async function settleSideEffects(label, bookingId, tasks) {
  const results = await Promise.allSettled(tasks.map((t) => t()));
  results.forEach((r) => {
    if (r.status === 'rejected') {
      console.error(`[payment] ${label} side effect failed booking=${bookingId}: ${r.reason && r.reason.message}`);
    }
  });
}

function rethrowAsHttp(res, e) {
  if (e instanceof PaymentError || e instanceof AmountError) {
    res.status(e.statusCode);
    throw new Error(e.message);
  }
  throw e;
}

// GET /api/payments/:bookingId/init — PaymentData for the customer screen
const initCustomerPayment = asyncHandler(async (req, res) => {
  const b = req.booking;
  const wallet = await WalletService.getOrCreateWallet(req.user._id, 'User');
  const amount = billOf(b);
  ok(res, {
    paymentId: `pay_${b._id}`,
    recipient: {
      id: String(b.provider._id),
      name: b.provider.fullName,
      image: avatar(b.provider.fullName, b.provider.profilePhoto),
    },
    details: {
      bookingId: String(b._id),
      service: b.serviceSubCategory || b.serviceCategory,
      description: b.description || b.instructions || '',
      amount,
      suggestedAmount: amount,
      invoiceId: `INV-${String(b._id).slice(-8).toUpperCase()}`,
    },
    availableMethods: [
      {
        id: 'wallet',
        name: 'MetroMatrix Wallet',
        icon: 'wallet',
        enabled: true,
        description: `Balance: ${rupees(wallet.balance)}`,
      },
      {
        id: 'cash',
        name: 'Cash',
        icon: 'cash',
        enabled: true,
        description: 'Pay the provider in person',
      },
    ],
    walletBalance: wallet.balance,
    // Where this payment already stands, so the screen can open on "waiting
    // for the provider to confirm your cash" or "paid" instead of offering to
    // take the money again.
    paymentStatus: b.payment.status,
    method: b.payment.method,
  }, 'Payment data fetched');
});

// POST /api/payments/process — { bookingId, method, amount? } → Transaction
//
// The server decides how much. `amount`, when sent, is only a check that the
// customer saw the current bill: if the provider changed it since the screen
// loaded, the customer is told and pays nothing until they have seen the new
// figure.
const processPayment = asyncHandler(async (req, res) => {
  const { bookingId, method, amount } = req.body;
  if (!mongoose.isValidObjectId(bookingId)) {
    res.status(400);
    throw new Error('A valid booking is required');
  }
  const b = await Booking.findById(bookingId)
    .populate('provider', 'fullName profilePhoto')
    .populate('customer', 'fullName');
  if (!b) {
    res.status(404);
    throw new Error('Booking not found');
  }
  const customerId = b.customer && b.customer._id ? b.customer._id : b.customer;
  if (String(customerId) !== String(req.user._id)) {
    res.status(403);
    throw new Error('Only the booking customer can pay');
  }

  const payWith = normalizeMethod(method);
  if (!payWith) {
    res.status(400);
    throw new Error('Choose how to pay: wallet or cash');
  }

  const bill = billOf(b);
  if (!(bill > 0)) {
    res.status(400);
    throw new Error('This job has no amount to pay yet');
  }
  if (amount !== undefined && amount !== null && amount !== '') {
    if (Math.round(Number(amount)) !== Math.round(bill)) {
      res.status(409);
      throw new Error(`The amount due for this job is now ${rupees(bill)}. Review it and try again.`);
    }
  }

  const service = b.serviceSubCategory || b.serviceCategory;

  if (payWith === 'cash') {
    try {
      assertPayable(b);
    } catch (e) {
      rethrowAsHttp(res, e);
    }
    // Nothing moves until the provider confirms receipt. The provider's
    // requested amount is never overwritten here — it is the bill.
    b.payment.method = 'cash';
    b.payment.status = 'requested';
    if (!b.payment.requestedAmount) b.payment.requestedAmount = bill;
    await b.save();

    await settleSideEffects('cash-selected', b._id, [
      () =>
        require('../services/notificationService').notifyCashSelected(b, {
          amount: bill,
          customerName: req.user.fullName,
        }),
      () =>
        require('../../../sockets').pushToUser(b.provider._id, 'provider', {
          type: 'payment_update',
          title: 'Cash payment',
          body: `${req.user.fullName || 'The customer'} will pay ${rupees(bill)} in cash for the ${String(service || 'service').toLowerCase()} job.`,
          data: { bookingId: String(b._id), roomType: 'homeservice', audience: 'provider' },
        }),
    ]);

    return ok(res, {
      transactionId: `CASH-${b._id}`,
      status: 'pending',
      method: 'cash',
      amount: bill,
      currency: 'PKR',
      paidAt: null,
    }, `Pay ${rupees(bill)} in cash — ${b.provider.fullName || 'the provider'} will confirm once received`);
  }

  let transaction;
  try {
    ({ transaction } = await payWithWallet(b, req.user, bill));
  } catch (e) {
    rethrowAsHttp(res, e);
  }

  // The provider must be TOLD: the durable notification backs their bell, the
  // room event updates an open payment screen, the push reaches a closed app.
  const paidAtIso = b.payment.paidAt.toISOString();
  await settleSideEffects('wallet-paid', b._id, [
    () =>
      require('../services/notificationService').notifyPaymentReceived(b, {
        amount: bill,
        method: b.payment.method,
        customerName: req.user.fullName,
      }),
    () =>
      require('../../../sockets').emitToBooking(b._id, 'payment_received', {
        bookingId: String(b._id),
        roomId: String(b._id),
        amount: bill,
        method: b.payment.method,
        transactionId: String(transaction._id),
        paidAt: paidAtIso,
      }),
    () =>
      require('../../../sockets').pushToUser(b.provider._id, 'provider', {
        type: 'payment_received',
        title: 'Payment received',
        body: `${rupees(bill)} received from ${req.user.fullName || 'the customer'}.`,
        data: { bookingId: String(b._id), roomType: 'homeservice', audience: 'provider' },
      }),
  ]);

  return ok(res, {
    transactionId: String(transaction._id),
    status: 'completed',
    method: 'wallet',
    amount: bill,
    currency: 'PKR',
    paidAt: paidAtIso,
  }, 'Payment successful');
});

// GET /api/provider/jobs/:jobId/payment — PaymentInitData
const initProviderPayment = asyncHandler(async (req, res) => {
  const b = req.booking;
  const amount = billOf(b);
  ok(res, {
    jobId: String(b._id),
    amount,
    serviceType: b.serviceSubCategory || b.serviceCategory,
    customerName: b.customer.fullName,
    breakdown: {
      serviceCharge: amount,
      materialCost: 0,
      additionalCharges: 0,
      discount: 0,
      tax: 0,
    },
    paymentStatus: b.payment.status,
    method: b.payment.method,
  }, 'Payment initialized');
});

// POST /api/provider/jobs/:jobId/request-payment — { amount }
const requestPayment = asyncHandler(async (req, res) => {
  const b = req.booking;
  let amount;
  try {
    assertPayable(b);
    const raw = req.body && req.body.amount !== undefined ? req.body.amount : billOf(b);
    amount = parseProviderAmount(raw, b, 'Amount');
  } catch (e) {
    rethrowAsHttp(res, e);
  }

  b.payment.requestedAmount = amount;
  b.payment.status = 'requested';
  b.pricing.finalPrice = amount;
  await b.save();

  const service = b.serviceSubCategory || b.serviceCategory;
  await settleSideEffects('request', b._id, [
    () =>
      require('../../../sockets').emitToBooking(b._id, 'payment_requested', {
        bookingId: String(b._id),
        roomId: String(b._id),
        amount,
      }),
    () =>
      require('../services/notificationService').notifyPaymentRequested(b, {
        amount,
        providerName: b.provider.fullName,
        service,
      }),
    () =>
      require('../../../sockets').pushToUser(b.customer._id, 'user', {
        type: 'payment_requested',
        title: 'Payment requested',
        body: `${b.provider.fullName || 'Your provider'} requested ${rupees(amount)} for the ${String(service || 'service').toLowerCase()} job.`,
        data: { bookingId: String(b._id), roomType: 'homeservice', audience: 'customer' },
      }),
  ]);

  ok(res, { requestId: `REQ-${b._id}`, amount }, 'Payment requested');
});

// POST /api/provider/jobs/:jobId/confirm-payment — { transactionId } (online path)
const confirmOnlinePayment = asyncHandler(async (req, res) => {
  const b = req.booking;
  ok(res, { confirmed: b.payment.status === 'paid' },
    b.payment.status === 'paid' ? 'Payment confirmed' : 'Payment not yet received');
});

// POST /api/provider/jobs/:jobId/confirm-cash — provider confirms cash received
const confirmCashPayment = asyncHandler(async (req, res) => {
  const b = req.booking;
  let transaction;
  try {
    ({ transaction } = await confirmCash(b, req.user));
  } catch (e) {
    rethrowAsHttp(res, e);
  }

  // The customer's payment screen is waiting on exactly this: turn "pay in
  // cash" into "paid" the moment the provider confirms, not on next refresh.
  const amount = billOf(b);
  await settleSideEffects('cash-confirmed', b._id, [
    () =>
      require('../../../sockets').emitToBooking(b._id, 'payment_received', {
        bookingId: String(b._id),
        roomId: String(b._id),
        amount,
        method: 'cash',
        transactionId: String(transaction._id),
        paidAt: b.payment.paidAt ? b.payment.paidAt.toISOString() : new Date().toISOString(),
      }),
    () =>
      require('../services/notificationService').notifyCashConfirmed(b, {
        amount,
        providerName: b.provider.fullName,
      }),
    () =>
      require('../../../sockets').pushToUser(b.customer._id, 'user', {
        type: 'payment_received',
        title: 'Payment confirmed',
        body: `${b.provider.fullName || 'Your provider'} confirmed your cash payment of ${rupees(amount)}.`,
        data: { bookingId: String(b._id), roomType: 'homeservice', audience: 'customer' },
      }),
  ]);

  ok(res, { transactionId: String(transaction._id) }, 'Cash payment confirmed');
});

module.exports = {
  initCustomerPayment,
  processPayment,
  initProviderPayment,
  requestPayment,
  confirmOnlinePayment,
  confirmCashPayment,
  normalizeMethod,
};
