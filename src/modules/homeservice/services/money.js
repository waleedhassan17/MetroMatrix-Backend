/**
 * What a home-service job costs, decided in ONE place.
 *
 * Before this, every endpoint worked the bill out for itself — some read
 * `requestedAmount` first, some skipped it — and the customer's payment call
 * charged whatever `amount` the phone sent. A customer could settle a
 * Rs. 2,000 job for Rs. 1 from the payment screen's "Change" field, and the
 * cash path overwrote the provider's requested amount with the customer's
 * number. The server now owns the price: the provider sets it (at completion
 * or when requesting payment), everyone else reads it from here.
 */

class AmountError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Hard ceiling on any single job, whatever the estimate. */
const ABSOLUTE_MAX_AMOUNT = 500000;
/** Floor for the per-job ceiling, so a low estimate never blocks a real bill. */
const MIN_JOB_CEILING = 100000;

/**
 * The amount this booking is WORTH: what the provider asked for, else the final
 * price they entered at completion, else the estimate.
 *
 * The estimate fallback is what makes this the provider's number. Their screens
 * seed a visit charge from it before anyone has quoted anything, earnings
 * aggregate over it, and `maxAmountFor` derives a per-job ceiling from it.
 * For what the CUSTOMER can be charged, use `quotedBill` — see why there.
 */
function billOf(booking) {
  const payment = booking.payment || {};
  const pricing = booking.pricing || {};
  return payment.requestedAmount || pricing.finalPrice || pricing.estimatedPrice || 0;
}

/**
 * What the CUSTOMER owes. Deliberately does NOT fall back to the estimate.
 *
 * A booking is stamped with `estimatedPrice = provider.basePrice` the moment it
 * is created, so `billOf` reports a payable amount from day one. That is the
 * provider's visit charge, not a bill: it made the customer's bookings tab show
 * a flat "PKR 500" under a booking screen that said "quoted after the visit",
 * and — worse — let the customer pay that 500 the moment the job was marked
 * complete, before the provider had entered the real figure. Whatever the
 * provider billed afterwards, the job was already settled at the estimate.
 *
 * A home-service job is priced on completion, so until the provider requests
 * payment (or enters a final price) there is nothing to pay, and zero is the
 * honest answer. The client already renders it as "Priced on completion".
 */
function quotedBill(booking) {
  const payment = booking.payment || {};
  const pricing = booking.pricing || {};
  return payment.requestedAmount || pricing.finalPrice || 0;
}

/** The most a provider may bill for this booking. */
function maxAmountFor(booking) {
  const estimate = (booking.pricing && booking.pricing.estimatedPrice) || 0;
  return Math.min(ABSOLUTE_MAX_AMOUNT, Math.max(MIN_JOB_CEILING, estimate * 20));
}

/**
 * Parse a provider-entered amount. Rejects anything that is not a finite
 * number above zero and within this booking's ceiling, and rounds to whole
 * rupees — the ledger and every screen deal in whole PKR.
 */
function parseProviderAmount(raw, booking, label = 'Amount') {
  const n = typeof raw === 'string' ? Number(raw.trim()) : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new AmountError(`${label} must be a number above zero`);
  }
  const rounded = Math.round(n);
  if (rounded < 1) {
    throw new AmountError(`${label} must be at least Rs. 1`);
  }
  const max = maxAmountFor(booking);
  if (rounded > max) {
    throw new AmountError(`${label} can't be more than Rs. ${max.toLocaleString('en-PK')} for this job`);
  }
  return rounded;
}

/**
 * Once the customer has been asked to pay, or has paid, the price is fixed.
 * Changing it afterwards would move the goalposts under a payment in flight.
 */
function assertPriceEditable(booking) {
  const status = booking.payment && booking.payment.status;
  if (status === 'paid') {
    throw new AmountError('This job has already been paid, so its price can no longer change', 409);
  }
}

module.exports = {
  AmountError,
  ABSOLUTE_MAX_AMOUNT,
  billOf,
  quotedBill,
  maxAmountFor,
  parseProviderAmount,
  assertPriceEditable,
};
