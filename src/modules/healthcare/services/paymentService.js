const Appointment = require('../models/Appointment');
const Doctor = require('../models/Doctor');
const WalletService = require('../../../services/walletService');
const { getHealthcareSettings } = require('./settingsService');

/**
 * ── Pure logic (unit-tested without a DB) ──────────────────────────
 */

/**
 * Refund policy on cancellation:
 *  - patient cancels ≥ cancellationWindowHours before the slot → 100%
 *  - patient cancels inside the window → lateCancelRefundPercent
 *  - doctor (or admin/system) cancels → always 100%
 * Returns whole rupees.
 */
const computeRefundAmount = (
  { amountPaid, slotStart, now, cancelledBy },
  { cancellationWindowHours, lateCancelRefundPercent }
) => {
  if (!amountPaid || amountPaid <= 0) return 0;
  if (cancelledBy !== 'patient') return amountPaid; // doctor/system/admin: full
  const hoursUntil = (slotStart.getTime() - now.getTime()) / 3600000;
  if (hoursUntil >= cancellationWindowHours) return amountPaid;
  return Math.round((amountPaid * lateCancelRefundPercent) / 100);
};

/** Commission split for a completed appointment. Whole rupees. */
const computePayout = (amount, commissionPercent) => {
  const commission = Math.round((amount * commissionPercent) / 100);
  return { commission, payout: amount - commission };
};

const slotStartDate = (slot) => {
  // Slot stores date (YYYY-MM-DD or Date) + startTime "HH:mm"
  const date = slot.date instanceof Date ? slot.date.toISOString().slice(0, 10) : String(slot.date);
  return new Date(`${date}T${slot.startTime || '00:00'}:00`);
};

/**
 * ── DB-backed operations ───────────────────────────────────────────
 */

class PaymentError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Pay for an appointment.
 *  - wallet: debit patient now, record WalletTransaction, mark paid.
 *  - cash_at_clinic: stays unpaid; captured when the doctor completes.
 */
const payAppointment = async (appointment, user, method) => {
  if (!['wallet', 'cash_at_clinic'].includes(method)) {
    throw new PaymentError("method must be 'wallet' or 'cash_at_clinic'");
  }
  if (['cancelled', 'completed'].includes(appointment.status)) {
    throw new PaymentError(`This appointment is ${appointment.status} and cannot be paid`);
  }
  if (appointment.payment && appointment.payment.status === 'paid') {
    throw new PaymentError('This appointment is already paid');
  }

  const amount = appointment.payment?.amount ?? appointment.totalAmount ?? 0;

  if (method === 'cash_at_clinic') {
    appointment.payment.method = 'cash_at_clinic';
    await appointment.save();
    return appointment;
  }

  if (amount <= 0) {
    // Free consultation — mark paid without touching the wallet
    appointment.payment = {
      ...appointment.payment.toObject(),
      status: 'paid',
      method: 'wallet',
      paidAt: new Date(),
    };
    await appointment.save();
    return appointment;
  }

  const wallet = await WalletService.getOrCreateWallet(user._id, 'User');
  if (wallet.balance < amount) {
    throw new PaymentError(
      `Insufficient wallet balance: you have PKR ${wallet.balance} but the consultation fee is PKR ${amount}`
    );
  }
  await wallet.debit(amount);
  const txn = await WalletService.recordTransaction(wallet._id, {
    type: 'debit',
    amount,
    description: `Consultation fee for appointment ${appointment._id}`,
    source: 'service_payment',
    status: 'completed',
    metadata: { appointmentId: String(appointment._id) },
  });

  appointment.payment.status = 'paid';
  appointment.payment.method = 'wallet';
  appointment.payment.walletTransactionId = txn._id;
  appointment.payment.paidAt = new Date();
  await appointment.save();
  return appointment;
};

/**
 * Refund on cancellation (policy above). Credits the patient wallet through
 * walletService so it shows in transaction history. Idempotent per appointment.
 */
const refundAppointment = async (appointment, { cancelledBy, reason, ratioOverride }) => {
  if (!appointment.payment || appointment.payment.status !== 'paid') return 0;
  if (appointment.payment.refundedAt) return 0; // already refunded

  const settings = await getHealthcareSettings();
  let refund;
  if (ratioOverride !== undefined) {
    refund = Math.round(appointment.payment.amount * ratioOverride);
  } else {
    let slotStart = new Date();
    if (appointment.slotId && appointment.slotId.date) {
      slotStart = slotStartDate(appointment.slotId);
    }
    refund = computeRefundAmount(
      {
        amountPaid: appointment.payment.amount,
        slotStart,
        now: new Date(),
        cancelledBy,
      },
      settings
    );
  }
  if (refund <= 0) return 0;

  const wallet = await WalletService.getOrCreateWallet(appointment.patientId, 'User');
  await wallet.credit(refund);
  await WalletService.recordTransaction(wallet._id, {
    type: 'credit',
    amount: refund,
    description: reason || `Refund for cancelled appointment ${appointment._id}`,
    source: 'refund',
    status: 'completed',
    metadata: { appointmentId: String(appointment._id) },
  });

  appointment.payment.status = 'refunded';
  appointment.payment.refundedAt = new Date();
  appointment.payment.refundAmount = refund;
  await appointment.save();
  return refund;
};

/**
 * Doctor payout at completion (not at payment time): credit the doctor's
 * Provider wallet with fee minus platform commission. Also captures
 * cash_at_clinic payments as paid. Idempotent.
 */
const settleCompletedAppointment = async (appointment) => {
  if (appointment.payout && appointment.payout.paidAt) return; // already settled

  // COD-style capture: cash at clinic becomes paid at completion
  if (appointment.payment && appointment.payment.status === 'unpaid') {
    if (appointment.payment.method === 'cash_at_clinic') {
      appointment.payment.status = 'paid';
      appointment.payment.paidAt = new Date();
    } else {
      // never paid and not cash — nothing to pay out
      await appointment.save();
      return;
    }
  }
  if (appointment.payment.status !== 'paid') return;

  const settings = await getHealthcareSettings();
  const amount = appointment.payment.amount || 0;
  if (amount <= 0) return;
  const { commission, payout } = computePayout(amount, settings.commissionPercent);

  const doctor = await Doctor.findById(appointment.doctorId);
  if (!doctor) return;
  const wallet = await WalletService.getOrCreateWallet(doctor.providerId, 'Provider');
  await wallet.credit(payout);
  const txn = await WalletService.recordTransaction(wallet._id, {
    type: 'credit',
    amount: payout,
    description: `Consultation earnings for appointment ${appointment._id} (after ${settings.commissionPercent}% platform commission)`,
    source: 'service_payment',
    status: 'completed',
    metadata: { appointmentId: String(appointment._id), commission },
  });
  appointment.payout = { amount: payout, commission, paidAt: new Date(), walletTransactionId: txn._id };
  await appointment.save();
};

module.exports = {
  PaymentError,
  computeRefundAmount,
  computePayout,
  slotStartDate,
  payAppointment,
  refundAppointment,
  settleCompletedAppointment,
};
