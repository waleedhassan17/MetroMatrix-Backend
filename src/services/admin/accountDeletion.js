const User = require('../../models/User');
const Provider = require('../../models/Provider');
const Wallet = require('../../models/Wallet');
const Booking = require('../../modules/homeservice/models/Booking');
const PayoutRequest = require('../../modules/homeservice/models/PayoutRequest');
const { ACTIVE_STATUSES } = require('../../modules/homeservice/services/statusMap');
const Appointment = require('../../modules/healthcare/models/Appointment');
const Doctor = require('../../modules/healthcare/models/Doctor');
const Order = require('../../modules/shopping/models/Order');
const Brand = require('../../modules/shopping/models/Brand');
const AppError = require('../../utils/AppError');
const { ERROR_CODES } = require('../../utils/errorCodes');

/**
 * Deleting a user or provider from the admin console.
 *
 * It used to be a hard delete with no checks: the account vanished while it
 * still had open bookings, upcoming appointments, orders in transit, pending
 * payouts or money in its wallet, leaving those records pointing at nothing.
 * Now:
 *  - deletionBlockers() lists anything that must be settled first, and the
 *    delete is refused (409 DELETE_BLOCKED, reasons in details) until it is;
 *  - deletion is SOFT (models/plugins/softDelete.js): the document stays for
 *    history, disappears from every query, can't sign in, and a super admin
 *    can restore it;
 *  - the email is released (replaced by an unroutable placeholder and kept in
 *    deletedEmail) so the person can register again; restore puts it back if
 *    no live account has taken it meanwhile.
 */

const MODELS = { User, Provider };
const OPEN_APPOINTMENT_STATUSES = ['pending', 'confirmed'];
const OPEN_ORDER_STATUSES = ['pending', 'confirmed', 'processing', 'shipped', 'out_for_delivery'];

const MESSAGES = {
  open_bookings: (r) => `${r.count} home-service booking(s) still in progress`,
  upcoming_appointments: (r) => `${r.count} upcoming appointment(s)`,
  open_orders: (r) => `${r.count} order(s) not yet delivered or closed`,
  pending_payouts: (r) => `${r.count} payout request(s) awaiting a decision`,
  wallet_balance: (r) => `Wallet still holds ${r.currency || 'PKR'} ${r.amount}`,
};

const modelFor = (kind) => {
  const Model = MODELS[kind];
  if (!Model) throw new Error(`Unknown account kind: ${kind}`);
  return Model;
};

/** What has to be settled before this account can be deleted ([] = nothing). */
async function deletionBlockers(kind, account) {
  const id = account._id;
  const counts = {};
  if (kind === 'User') {
    [counts.open_bookings, counts.upcoming_appointments, counts.open_orders] = await Promise.all([
      Booking.countDocuments({ customer: id, status: { $in: ACTIVE_STATUSES } }),
      Appointment.countDocuments({ patientId: id, status: { $in: OPEN_APPOINTMENT_STATUSES } }),
      Order.countDocuments({ userId: id, orderStatus: { $in: OPEN_ORDER_STATUSES } }),
    ]);
  } else {
    const [doctorIds, brandIds] = await Promise.all([
      Doctor.find({ providerId: id }).distinct('_id'),
      Brand.find({ owner: id }).distinct('_id'),
    ]);
    [counts.open_bookings, counts.upcoming_appointments, counts.open_orders, counts.pending_payouts] = await Promise.all([
      Booking.countDocuments({ provider: id, status: { $in: ACTIVE_STATUSES } }),
      doctorIds.length ? Appointment.countDocuments({ doctorId: { $in: doctorIds }, status: { $in: OPEN_APPOINTMENT_STATUSES } }) : 0,
      brandIds.length ? Order.countDocuments({ brandId: { $in: brandIds }, orderStatus: { $in: OPEN_ORDER_STATUSES } }) : 0,
      PayoutRequest.countDocuments({ provider: id, status: 'pending' }),
    ]);
  }

  const reasons = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => ({ type, count }));
  const wallet = await Wallet.findOne({ owner: id, ownerType: kind }).lean();
  if (wallet && wallet.balance > 0) reasons.push({ type: 'wallet_balance', amount: wallet.balance, currency: wallet.currency });
  return reasons.map((r) => ({ ...r, message: MESSAGES[r.type](r) }));
}

const placeholderEmail = (id) => `${id}.deleted@accounts.invalid`;

/**
 * Soft-delete after checking blockers. Throws DELETE_BLOCKED (409) with the
 * reasons when something is still open.
 * @returns {{ deletedAt: Date }}
 */
async function softDeleteAccount(kind, account, { admin, reason }) {
  const blockers = await deletionBlockers(kind, account);
  if (blockers.length) {
    throw new AppError(ERROR_CODES.DELETE_BLOCKED, `This account can't be deleted yet: ${blockers.map((b) => b.message).join('; ')}.`, {
      details: { reasons: blockers },
    });
  }
  const deletedAt = new Date();
  // updateOne: no validators (the placeholder isn't meant to pass the email
  // regex) and no soft-delete filter.
  await modelFor(kind).updateOne(
    { _id: account._id },
    {
      $set: {
        deletedAt,
        deletedBy: admin._id,
        deleteReason: reason,
        deletedEmail: account.email,
        deletedWasActive: account.isActive !== false,
        email: placeholderEmail(account._id),
        isActive: false,
      },
      $unset: { refreshToken: 1, refreshSessions: 1 },
    }
  );
  return { deletedAt };
}

/** Undo a soft delete (super admin). */
async function restoreAccount(kind, id) {
  const Model = modelFor(kind);
  const doc = await Model.findOne({ _id: id, deletedAt: { $ne: null } })
    .select('+deletedEmail')
    .setOptions({ withDeleted: true })
    .lean();
  if (!doc) throw new AppError(ERROR_CODES.NOT_FOUND, `No deleted ${kind.toLowerCase()} with that id`);
  if (doc.deletedEmail && (await Model.exists({ email: doc.deletedEmail }))) {
    throw new AppError(ERROR_CODES.CONFLICT, 'Another account has registered with this email since it was deleted.', {
      details: { email: doc.deletedEmail },
    });
  }
  await Model.updateOne(
    { _id: id },
    {
      $set: {
        email: doc.deletedEmail || doc.email,
        isActive: doc.deletedWasActive !== false,
        deletedAt: null,
        deletedBy: null,
        deleteReason: '',
      },
      $unset: { deletedEmail: 1, deletedWasActive: 1 },
    }
  );
  return { restoredEmail: doc.deletedEmail || doc.email, deletedAt: doc.deletedAt, deleteReason: doc.deleteReason };
}

module.exports = { deletionBlockers, softDeleteAccount, restoreAccount, OPEN_APPOINTMENT_STATUSES, OPEN_ORDER_STATUSES };
