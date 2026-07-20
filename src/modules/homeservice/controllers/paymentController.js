const asyncHandler = require('express-async-handler');
const Booking = require('../models/Booking');
const WalletService = require('../../../services/walletService');
const {
  payWithWallet,
  confirmCash,
  assertPayable,
  PaymentError,
} = require('../services/paymentService');
const { avatar } = require('../services/serializers');

const ok = (res, data, message) => res.json({ success: true, data, message });

// GET /api/payments/:bookingId/init — PaymentData for the customer screen
const initCustomerPayment = asyncHandler(async (req, res) => {
  const b = req.booking;
  const wallet = await WalletService.getOrCreateWallet(req.user._id, 'User');
  const amount =
    b.payment.requestedAmount || b.pricing.finalPrice || b.pricing.estimatedPrice;
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
        id: 'cash',
        name: 'Cash',
        icon: 'cash',
        enabled: true,
        description: 'Pay with cash on completion',
      },
      {
        id: 'jazzcash',
        name: 'Wallet (JazzCash)',
        icon: 'phone-portrait',
        enabled: true,
        description: `Wallet balance: Rs. ${wallet.balance.toLocaleString('en-PK')}`,
      },
      {
        id: 'easypaisa',
        name: 'Wallet (EasyPaisa)',
        icon: 'phone-portrait',
        enabled: true,
        description: `Wallet balance: Rs. ${wallet.balance.toLocaleString('en-PK')}`,
      },
      {
        id: 'card',
        name: 'Credit/Debit Card',
        icon: 'card',
        enabled: false,
        description: 'Coming soon',
      },
    ],
    walletBalance: wallet.balance,
  }, 'Payment data fetched');
});

// POST /api/payments/process — { bookingId, method, amount, tipAmount? } → Transaction
const processPayment = asyncHandler(async (req, res) => {
  const { bookingId, method, amount, tipAmount } = req.body;
  const b = await Booking.findById(bookingId).populate('provider', 'fullName profilePhoto');
  if (!b) {
    res.status(404);
    throw new Error('Booking not found');
  }
  if (String(b.customer) !== String(req.user._id)) {
    res.status(403);
    throw new Error('Only the booking customer can pay');
  }

  const total = Number(amount) + (Number(tipAmount) || 0);

  try {
    if (method === 'cash') {
      // Customer chose cash — nothing moves until the provider confirms receipt.
      assertPayable(b);
      b.payment.method = 'cash';
      b.payment.status = 'requested';
      b.payment.requestedAmount = total;
      await b.save();
      return ok(res, {
        transactionId: `CASH-${b._id}`,
        status: 'pending',
        method: 'cash',
        amount: total,
        currency: 'PKR',
        paidAt: new Date().toISOString(),
      }, 'Cash payment selected — provider will confirm receipt');
    }

    // 'jazzcash' / 'easypaisa' both ride the in-app wallet (FYP scope: the
    // wallet IS the mobile-money stand-in; a real gateway is FYP-II work).
    const { transaction } = await payWithWallet(b, req.user, total);
    return ok(res, {
      transactionId: String(transaction._id),
      status: 'completed',
      method,
      amount: total,
      currency: 'PKR',
      paidAt: b.payment.paidAt.toISOString(),
    }, 'Payment successful');
  } catch (e) {
    if (e instanceof PaymentError) {
      res.status(e.statusCode);
      throw new Error(e.message);
    }
    throw e;
  }
});

// GET /api/provider/jobs/:jobId/payment — PaymentInitData
const initProviderPayment = asyncHandler(async (req, res) => {
  const b = req.booking;
  const amount =
    b.payment.requestedAmount || b.pricing.finalPrice || b.pricing.estimatedPrice;
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
  const { amount } = req.body;
  if (!amount || Number(amount) <= 0) {
    res.status(400);
    throw new Error('A positive amount is required');
  }
  try {
    assertPayable(b);
  } catch (e) {
    res.status(e.statusCode || 400);
    throw new Error(e.message);
  }
  b.payment.requestedAmount = Number(amount);
  b.payment.status = 'requested';
  b.pricing.finalPrice = Number(amount);
  await b.save();

  try {
    const { emitToBooking } = require('../../../sockets');
    emitToBooking(b._id, 'payment_requested', {
      bookingId: String(b._id),
      amount: Number(amount),
    });
  } catch (e) { /* socket layer unavailable */ }

  ok(res, { requestId: `REQ-${b._id}` }, 'Payment requested');
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
  try {
    const { transaction } = await confirmCash(b, req.user);
    ok(res, { transactionId: String(transaction._id) }, 'Cash payment confirmed');
  } catch (e) {
    if (e instanceof PaymentError) {
      res.status(e.statusCode);
      throw new Error(e.message);
    }
    throw e;
  }
});

module.exports = {
  initCustomerPayment,
  processPayment,
  initProviderPayment,
  requestPayment,
  confirmOnlinePayment,
  confirmCashPayment,
};
