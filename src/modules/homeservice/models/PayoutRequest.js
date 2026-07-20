const mongoose = require('mongoose');

const payoutRequestSchema = new mongoose.Schema(
  {
    provider: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Provider',
      required: true,
      index: true,
    },
    amount: { type: Number, required: true, min: 1 },
    method: { type: String, default: 'bank' },
    accountDetails: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    decidedAt: Date,
    rejectionReason: String,
    walletTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletTransaction' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('HSPayoutRequest', payoutRequestSchema);
