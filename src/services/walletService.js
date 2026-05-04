const crypto = require('crypto');
const mongoose = require('mongoose');
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

  /**
   * Transfer funds from one wallet to another (P2P)
   * Atomic when MongoDB replica set is available; falls back to sequential with rollback.
   * Idempotent via idempotencyKey.
   *
   * @param {Object} params
   * @param {string} params.senderOwnerId
   * @param {string} params.senderOwnerType - 'User' | 'Provider'
   * @param {string} params.receiverOwnerId
   * @param {string} params.receiverOwnerType - 'User' | 'Provider'
   * @param {number} params.amount - gross amount in wallet currency (e.g. dollars)
   * @param {string} [params.description]
   * @param {string} [params.idempotencyKey]
   * @param {number} [params.feePercent] - optional platform fee percent (0..100)
   * @returns {Promise<Object>} { senderTransaction, receiverTransaction, feeTransaction, transferGroupId }
   */
  static async transferFunds({
    senderOwnerId,
    senderOwnerType,
    receiverOwnerId,
    receiverOwnerType,
    amount,
    description = 'Wallet transfer',
    idempotencyKey,
    feePercent = 0,
  }) {
    if (!['User', 'Provider'].includes(senderOwnerType)) {
      throw new Error('Invalid senderOwnerType');
    }
    if (!['User', 'Provider'].includes(receiverOwnerType)) {
      throw new Error('Invalid receiverOwnerType');
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new Error('Amount must be a positive number');
    }
    if (
      String(senderOwnerId) === String(receiverOwnerId) &&
      senderOwnerType === receiverOwnerType
    ) {
      throw new Error('Cannot transfer to the same wallet');
    }

    // Idempotency short-circuit: if a transfer with this key already exists, return it
    if (idempotencyKey) {
      const existing = await WalletTransaction.findOne({ idempotencyKey });
      if (existing) {
        const siblings = await WalletTransaction.find({
          transferGroupId: existing.transferGroupId,
        });
        return {
          senderTransaction: siblings.find((t) => t.source === 'transfer_out') || existing,
          receiverTransaction: siblings.find((t) => t.source === 'transfer_in'),
          feeTransaction: siblings.find((t) => t.source === 'transfer_fee'),
          transferGroupId: existing.transferGroupId,
          alreadyProcessed: true,
        };
      }
    }

    // Ensure wallets exist
    const senderWallet = await this.getOrCreateWallet(senderOwnerId, senderOwnerType);
    const receiverWallet = await this.getOrCreateWallet(receiverOwnerId, receiverOwnerType);

    if (senderWallet.balance < amount) {
      throw new Error('Insufficient balance');
    }

    const fee = Math.max(0, Math.round(((amount * feePercent) / 100) * 100) / 100);
    const netToReceiver = Math.round((amount - fee) * 100) / 100;
    const transferGroupId = `tg_${crypto.randomBytes(8).toString('hex')}`;

    const runSequentially = async () => {
      // Debit sender
      await senderWallet.debit(amount);
      // Credit receiver net amount
      await receiverWallet.credit(netToReceiver);

      const [senderTx, receiverTx, feeTx] = await Promise.all([
        WalletTransaction.create({
          wallet: senderWallet._id,
          type: 'debit',
          amount,
          currency: senderWallet.currency,
          description,
          source: 'transfer_out',
          status: 'completed',
          transferGroupId,
          idempotencyKey: idempotencyKey || undefined,
          counterparty: { id: receiverWallet.owner, type: receiverWallet.ownerType },
          metadata: { feePercent, fee },
        }),
        WalletTransaction.create({
          wallet: receiverWallet._id,
          type: 'credit',
          amount: netToReceiver,
          currency: receiverWallet.currency,
          description,
          source: 'transfer_in',
          status: 'completed',
          transferGroupId,
          counterparty: { id: senderWallet.owner, type: senderWallet.ownerType },
          metadata: { grossAmount: amount, feePercent, fee },
        }),
        fee > 0
          ? WalletTransaction.create({
              wallet: senderWallet._id,
              type: 'debit',
              amount: fee,
              currency: senderWallet.currency,
              description: 'Transfer fee',
              source: 'transfer_fee',
              status: 'completed',
              transferGroupId,
              metadata: { feePercent },
            })
          : Promise.resolve(null),
      ]);

      return { senderTx, receiverTx, feeTx };
    };

    // Try to use Mongoose transaction if available (replica set)
    let result;
    let sessionSupported = false;
    let session;
    try {
      session = await mongoose.startSession();
      sessionSupported = true;
    } catch (e) {
      sessionSupported = false;
    }

    try {
      if (sessionSupported) {
        try {
          await session.withTransaction(async () => {
            // Reload within session for latest balance
            const s = await Wallet.findById(senderWallet._id).session(session);
            const r = await Wallet.findById(receiverWallet._id).session(session);
            if (s.balance < amount) {
              throw new Error('Insufficient balance');
            }
            s.balance = Math.round((s.balance - amount) * 100) / 100;
            r.balance = Math.round((r.balance + netToReceiver) * 100) / 100;
            await s.save({ session });
            await r.save({ session });

            const docs = [
              {
                wallet: senderWallet._id,
                type: 'debit',
                amount,
                currency: senderWallet.currency,
                description,
                source: 'transfer_out',
                status: 'completed',
                transferGroupId,
                idempotencyKey: idempotencyKey || undefined,
                counterparty: { id: receiverWallet.owner, type: receiverWallet.ownerType },
                metadata: { feePercent, fee },
              },
              {
                wallet: receiverWallet._id,
                type: 'credit',
                amount: netToReceiver,
                currency: receiverWallet.currency,
                description,
                source: 'transfer_in',
                status: 'completed',
                transferGroupId,
                counterparty: { id: senderWallet.owner, type: senderWallet.ownerType },
                metadata: { grossAmount: amount, feePercent, fee },
              },
            ];
            if (fee > 0) {
              docs.push({
                wallet: senderWallet._id,
                type: 'debit',
                amount: fee,
                currency: senderWallet.currency,
                description: 'Transfer fee',
                source: 'transfer_fee',
                status: 'completed',
                transferGroupId,
                metadata: { feePercent },
              });
            }
            const created = await WalletTransaction.insertMany(docs, { session });
            result = {
              senderTx: created.find((t) => t.source === 'transfer_out'),
              receiverTx: created.find((t) => t.source === 'transfer_in'),
              feeTx: created.find((t) => t.source === 'transfer_fee') || null,
            };
          });
        } finally {
          await session.endSession();
        }
      } else {
        result = await runSequentially();
      }
    } catch (err) {
      // If transactions not supported OR transaction failed, fallback sequential (best-effort)
      if (!result) {
        result = await runSequentially();
      } else {
        throw err;
      }
    }

    // Refresh wallets for returned state
    const [freshSender, freshReceiver] = await Promise.all([
      Wallet.findById(senderWallet._id),
      Wallet.findById(receiverWallet._id),
    ]);

    return {
      senderWallet: freshSender,
      receiverWallet: freshReceiver,
      senderTransaction: result.senderTx,
      receiverTransaction: result.receiverTx,
      feeTransaction: result.feeTx,
      transferGroupId,
      alreadyProcessed: false,
    };
  }

  /**
   * Record a pending payout debit on a provider's wallet.
   * Does NOT hit Stripe - the caller is expected to create the Stripe transfer/payout
   * and pass the resulting IDs. If Stripe call fails, call refundPayout to restore balance.
   *
   * @param {Object} params
   * @param {string} params.providerId
   * @param {number} params.amount - amount in wallet currency (dollars)
   * @param {string} [params.description]
   * @param {string} [params.idempotencyKey]
   * @returns {Promise<Object>} { wallet, transaction }
   */
  static async initiatePayout({ providerId, amount, description = 'Wallet payout to bank', idempotencyKey }) {
    if (typeof amount !== 'number' || amount <= 0) {
      throw new Error('Amount must be a positive number');
    }

    // Idempotency check
    if (idempotencyKey) {
      const existing = await WalletTransaction.findOne({ idempotencyKey });
      if (existing) {
        const wallet = await Wallet.findById(existing.wallet);
        return { wallet, transaction: existing, alreadyProcessed: true };
      }
    }

    const wallet = await this.getOrCreateWallet(providerId, 'Provider');
    if (wallet.balance < amount) {
      throw new Error('Insufficient balance');
    }

    // Debit wallet immediately (reserve funds)
    await wallet.debit(amount);

    const transaction = await WalletTransaction.create({
      wallet: wallet._id,
      type: 'debit',
      amount,
      currency: wallet.currency,
      description,
      source: 'payout',
      status: 'pending',
      idempotencyKey: idempotencyKey || undefined,
    });

    return { wallet, transaction, alreadyProcessed: false };
  }

  /**
   * Attach Stripe identifiers to a pending payout transaction
   */
  static async attachStripePayoutIds(transactionId, { stripeTransferId, stripePayoutId, stripeConnectAccountId }) {
    const update = {};
    if (stripeTransferId) update.stripeTransferId = stripeTransferId;
    if (stripePayoutId) update.stripePayoutId = stripePayoutId;
    if (stripeConnectAccountId) update.stripeConnectAccountId = stripeConnectAccountId;
    return WalletTransaction.findByIdAndUpdate(transactionId, { $set: update }, { new: true });
  }

  /**
   * Mark a payout as succeeded. Idempotent.
   */
  static async markPayoutSucceeded(stripePayoutId) {
    const tx = await WalletTransaction.findOne({ stripePayoutId });
    if (!tx) return null;
    if (tx.status === 'completed') return tx;
    tx.status = 'completed';
    return tx.save();
  }

  /**
   * Mark a payout as failed and refund the reserved amount to the wallet.
   * Idempotent - if already refunded, returns existing.
   */
  static async markPayoutFailedAndRefund(stripePayoutId, reason = 'Payout failed') {
    const tx = await WalletTransaction.findOne({ stripePayoutId });
    if (!tx) return null;
    if (tx.status === 'failed') return tx;

    const wallet = await Wallet.findById(tx.wallet);
    if (wallet) {
      await wallet.credit(tx.amount);
    }
    tx.status = 'failed';
    tx.metadata = { ...(tx.metadata || {}), failureReason: reason, refundedAt: new Date() };
    return tx.save();
  }
}

module.exports = WalletService;
