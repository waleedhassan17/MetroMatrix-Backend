const mongoose = require('mongoose');

const disputeSchema = new mongoose.Schema(
  {
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'HSBooking',
      required: true,
      index: true,
    },
    raisedBy: {
      id: { type: mongoose.Schema.Types.ObjectId, required: true },
      role: { type: String, enum: ['customer', 'provider'], required: true },
    },
    againstRole: { type: String, enum: ['customer', 'provider'], required: true },
    reason: { type: String, required: true },
    description: { type: String, maxlength: 2000, default: '' },
    evidence: [String], // image URLs
    status: {
      type: String,
      enum: ['open', 'investigating', 'resolved', 'rejected'],
      default: 'open',
      index: true,
    },
    resolution: String,
    refundAmount: { type: Number, default: 0 },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    resolvedAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model('HSDispute', disputeSchema);
