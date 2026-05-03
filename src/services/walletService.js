const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');

class WalletService {
  /**
   * Get or create a wallet for a given owner
   * @param {string} ownerId - The ID of the owner (User or Provider)
   * @param {string} ownerType - The type of owner ('User' or 'Provider')
   * @returns {Promise<Wallet>} - The wallet document
   * @throws {Error} - If ownerType is invalid
   */
  static async getOrCreateWallet(ownerId, ownerType) {
    if (!['User', 'Provider'].includes(ownerType)) {
      throw new Error('Invalid owner type. Must be User or Provider');
    }

    let wallet = await Wallet.findOne({ owner: ownerId, ownerType });

    if (!wallet) {
      wallet = await Wallet.create({
        owner: ownerId,
        ownerType,
        balance: 0,
        currency: 'usd',
      });
    }

    return wallet;
  }

  /**
   * Get wallet with paginated transaction history
   * @param {string} ownerId - The ID of the owner
   * @param {string} ownerType - The type of owner ('User' or 'Provider')
   * @param {Object} options - Pagination options
   * @param {number} options.limit - Number of transactions per page (default: 20)
   * @param {number} options.page - Page number (default: 1)
   * @returns {Promise<Object>} - Object containing wallet, transactions, and pagination info
   */
  static async getWalletWithTransactions(ownerId, ownerType, { limit = 20, page = 1 } = {}) {
    const wallet = await this.getOrCreateWallet(ownerId, ownerType);

    const skip = (page - 1) * limit;

    const total = await WalletTransaction.countDocuments({ wallet: wallet._id });
    const transactions = await WalletTransaction.find({ wallet: wallet._id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip);

    return {
      wallet,
      transactions,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Record a wallet transaction with idempotency protection
   * @param {string} walletId - The wallet ID
   * @param {Object} transactionData - Transaction details
   * @param {string} transactionData.type - Transaction type ('credit' or 'debit')
   * @param {number} transactionData.amount - Transaction amount
   * @param {string} transactionData.description - Transaction description
   * @param {string} transactionData.source - Transaction source
   * @param {string} [transactionData.status] - Transaction status (default: 'pending')
   * @param {string} [transactionData.stripeSessionId] - Stripe session ID for idempotency
   * @param {string} [transactionData.stripePaymentIntentId] - Stripe payment intent ID
   * @param {Object} [transactionData.metadata] - Additional metadata
   * @returns {Promise<WalletTransaction>} - The created or existing transaction
   */
  static async recordTransaction(walletId, {
    type,
    amount,
    description,
    source,
    status = 'pending',
    stripeSessionId,
    stripePaymentIntentId,
    metadata,
  }) {
    // Idempotency check: if stripeSessionId is provided, check for existing transaction
    if (stripeSessionId) {
      const existingTransaction = await WalletTransaction.findOne({
        stripeSessionId,
      });
      
      if (existingTransaction) {
        return existingTransaction;
      }
    }

    const transaction = await WalletTransaction.create({
      wallet: walletId,
      type,
      amount,
      description,
      source,
      status,
      stripeSessionId,
      stripePaymentIntentId,
      metadata,
    });

    return transaction;
  }

  /**
   * Apply a Stripe top-up to a wallet (called by webhook)
   * @param {Object} stripeSession - Stripe session object
   * @returns {Promise<Object>} - Object containing wallet and transaction
   * @throws {Error} - If session metadata is missing or invalid
   */
  static async applyTopUp(stripeSession) {
    const { metadata, amount_total, id: sessionId, payment_intent } = stripeSession;

    if (!metadata || !metadata.ownerId || !metadata.ownerType) {
      throw new Error('Invalid session: missing ownerId or ownerType in metadata');
    }

    const { ownerId, ownerType } = metadata;
    const amount = amount_total / 100; // Convert from cents to dollars

    // Get or create wallet
    const wallet = await this.getOrCreateWallet(ownerId, ownerType);

    // Record transaction with idempotency
    const transaction = await this.recordTransaction(wallet._id, {
      type: 'credit',
      amount,
      description: 'Stripe wallet top-up',
      source: 'stripe_topup',
      status: 'pending',
      stripeSessionId: sessionId,
      stripePaymentIntentId: payment_intent,
      metadata: {
        stripeSessionId: sessionId,
        originalAmountCents: amount_total,
      },
    });

    // Check if this is a new transaction (not a duplicate)
    const isNewTransaction = transaction.createdAt.getTime() === Date.now() ||
                             (Date.now() - transaction.createdAt.getTime()) < 1000;

    if (isNewTransaction) {
      // Try to use Mongoose transaction if MongoDB is a replica set
      try {
        const session = await Wallet.startSession();
        
        if (session) {
          // MongoDB is a replica set - use transaction
          try {
            await session.withTransaction(async () => {
              // Credit the wallet
              await wallet.credit(amount);
              
              // Update transaction status to completed
              transaction.status = 'completed';
              await transaction.save({ session });
            });
            
            await session.endSession();
          } catch (error) {
            await session.endSession();
            throw error;
          }
        } else {
          // MongoDB is not a replica set - do sequentially
          await wallet.credit(amount);
          transaction.status = 'completed';
          await transaction.save();
        }
      } catch (transactionError) {
        // If transaction support fails, fall back to sequential
        try {
          await wallet.credit(amount);
          transaction.status = 'completed';
          await transaction.save();
        } catch (fallbackError) {
          transaction.status = 'failed';
          await transaction.save();
          throw new Error(`Failed to apply top-up: ${fallbackError.message}`);
        }
      }
    }

    return {
      wallet,
      transaction,
    };
  }
}

module.exports = WalletService;
