const mongoose = require('mongoose');

/**
 * WalletTransaction Schema
 * Records all transactions that occur on a wallet
 * Tracks credits, debits, refunds, and other wallet operations
 */
const walletTransactionSchema = new mongoose.Schema(
  {
    /**
     * Reference to the wallet this transaction belongs to
     */
    wallet: {
      type: mongoose.Schema.Types.ObjectId,
      required: [true, 'Wallet is required'],
      ref: 'Wallet',
      index: true,
    },

    /**
     * Transaction type
     * credit: Funds added to wallet
     * debit: Funds removed from wallet
     */
    type: {
      type: String,
      required: [true, 'Transaction type is required'],
      enum: {
        values: ['credit', 'debit'],
        message: 'Transaction type must be either credit or debit',
      },
    },

    /**
     * Transaction amount
     * Must be at least 0.01
     */
    amount: {
      type: Number,
      required: [true, 'Transaction amount is required'],
      min: [0.01, 'Transaction amount must be at least 0.01'],
    },

    /**
     * Currency for this transaction
     */
    currency: {
      type: String,
      default: 'usd',
    },

    /**
     * Human-readable description of the transaction
     */
    description: {
      type: String,
      required: [true, 'Transaction description is required'],
    },

    /**
     * Transaction status
     * pending: Transaction initiated but not completed
     * completed: Transaction successfully processed
     * failed: Transaction failed
     * refunded: Transaction was refunded
     */
    status: {
      type: String,
      enum: {
        values: ['pending', 'completed', 'failed', 'refunded'],
        message: 'Status must be one of: pending, completed, failed, refunded',
      },
      default: 'pending',
    },

    /**
     * Source of the transaction
     * stripe_topup: User added funds via Stripe
     * service_payment: Payment for a service
     * refund: Refund issued
     * admin_adjustment: Manual adjustment by admin
     * payout: Funds withdrawn to external account
     */
    source: {
      type: String,
      enum: {
        values: [
          'stripe_topup',
          'service_payment',
          'refund',
          'admin_adjustment',
          'payout',
          'transfer_in',
          'transfer_out',
          'transfer_fee',
        ],
        message:
          'Source must be one of: stripe_topup, service_payment, refund, admin_adjustment, payout, transfer_in, transfer_out, transfer_fee',
      },
    },

    /**
     * Counterparty for transfer-related transactions
     * Points to the other party involved (sender or receiver)
     */
    counterparty: {
      id: {
        type: mongoose.Schema.Types.ObjectId,
        refPath: 'counterparty.type',
      },
      type: {
        type: String,
        enum: ['User', 'Provider'],
      },
    },

    /**
     * Transfer group ID - links the two legs (debit + credit) of a transfer
     */
    transferGroupId: {
      type: String,
      index: true,
      sparse: true,
    },

    /**
     * Client-supplied idempotency key for transfers (sparse + unique)
     */
    idempotencyKey: {
      type: String,
      sparse: true,
      unique: true,
    },

    /**
     * Stripe Connect / payout related identifiers
     */
    stripePayoutId: {
      type: String,
      sparse: true,
    },
    stripeTransferId: {
      type: String,
      sparse: true,
    },
    stripeConnectAccountId: {
      type: String,
      sparse: true,
    },

    /**
     * Stripe checkout session ID
     * Used for tracking Stripe checkout sessions
     * Sparse index allows null values
     */
    stripeSessionId: {
      type: String,
      sparse: true,
      unique: true,
    },

    /**
     * Stripe payment intent ID
     * Used for tracking Stripe payment intents
     * Sparse index allows null values
     */
    stripePaymentIntentId: {
      type: String,
      sparse: true,
    },

    /**
     * Additional metadata for the transaction
     * Can store arbitrary data related to the transaction
     */
    metadata: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

/**
 * Index on wallet and createdAt for fast transaction history queries
 * Allows efficient retrieval of a wallet's transactions in chronological order
 */
walletTransactionSchema.index({ wallet: 1, createdAt: -1 });

module.exports = mongoose.model('WalletTransaction', walletTransactionSchema);
