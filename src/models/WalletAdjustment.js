const mongoose = require('mongoose');

/**
 * A manual credit/debit of a wallet by an admin.
 *
 * Maker-checker: an adjustment at or below finance.adjustmentApprovalThreshold
 * is applied when requested; above it, it stays `pending` until a DIFFERENT
 * super admin approves (or rejects) it. Applying moves the balance and writes
 * the ledger row in one MongoDB transaction; the ledger row's idempotency key
 * is this adjustment's id, so it can never be applied twice.
 *
 * status: pending → applying → applied | failed;  pending → rejected
 */
const walletAdjustmentSchema = new mongoose.Schema(
  {
    wallet: { type: mongoose.Schema.Types.ObjectId, ref: 'Wallet', required: true, index: true },
    direction: { type: String, enum: ['credit', 'debit'], required: true },
    amount: { type: Number, required: true, min: 0.01 },
    currency: { type: String, default: 'PKR' },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    status: {
      type: String,
      enum: ['pending', 'applying', 'applied', 'rejected', 'failed'],
      default: 'pending',
      index: true,
    },
    requiresApproval: { type: Boolean, default: false },
    thresholdAtRequest: { type: Number, default: null },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: '' },
    transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletTransaction', default: null },
    balanceBefore: { type: Number, default: null },
    balanceAfter: { type: Number, default: null },
    failureReason: { type: String, default: '' },
  },
  { timestamps: true }
);

walletAdjustmentSchema.index({ status: 1, createdAt: 1 });

walletAdjustmentSchema.methods.toPublic = function () {
  return {
    id: String(this._id),
    walletId: String(this.wallet),
    direction: this.direction,
    amount: this.amount,
    currency: this.currency,
    reason: this.reason,
    status: this.status,
    requiresApproval: this.requiresApproval,
    thresholdAtRequest: this.thresholdAtRequest,
    requestedBy: this.requestedBy ? String(this.requestedBy) : null,
    decidedBy: this.decidedBy ? String(this.decidedBy) : null,
    decidedAt: this.decidedAt,
    decisionNote: this.decisionNote || null,
    transactionId: this.transaction ? String(this.transaction) : null,
    balanceBefore: this.balanceBefore,
    balanceAfter: this.balanceAfter,
    failureReason: this.failureReason || null,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('WalletAdjustment', walletAdjustmentSchema);
