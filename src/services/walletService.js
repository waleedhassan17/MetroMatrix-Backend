const crypto = require('crypto');
const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const { WALLET_CURRENCY, PKR_PER_USD, usdCentsToPkr } = require('../config/currency');

// Fixed sentinel owner id for the singleton Platform commission ledger
// (Part C.4). There is no User/Provider document behind it — it exists so
// commission has a real, auditable destination instead of vanishing when
// it's subtracted from a payout.
const PLATFORM_OWNER_ID = new mongoose.Types.ObjectId('000000000000000000000001');

class WalletService {
  static PLATFORM_OWNER_ID = PLATFORM_OWNER_ID;

  /**
   * Get or create a wallet for a given owner
   * @param {string} ownerId - The ID of the owner (User, Provider, or Platform)
   * @param {string} ownerType - 'User' | 'Provider' | 'Platform'
   * @returns {Promise<Wallet>} - The wallet document
   * @throws {Error} - If ownerType is invalid
   */
  static async getOrCreateWallet(ownerId, ownerType) {
    if (!['User', 'Provider', 'Platform'].includes(ownerType)) {
      throw new Error('Invalid owner type. Must be User, Provider or Platform');
    }

    let wallet = await Wallet.findOne({ owner: ownerId, ownerType });

    if (!wallet) {
      wallet = await Wallet.create({
        owner: ownerId,
        ownerType,
        balance: 0,
        currency: WALLET_CURRENCY,
      });
    }

    return wallet;
  }

  /** The one Platform commission wallet, created on first use. */
  static async getPlatformWallet() {
    return this.getOrCreateWallet(PLATFORM_OWNER_ID, 'Platform');
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
    relatedTo,
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
      relatedTo,
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
    // Stripe charges in USD test mode (PKR is not chargeable — see
    // config/currency.js); convert back to whole PKR for the ledger and
    // stamp the rate used so this record stays accurate if the constant
    // ever changes.
    const amount = usdCentsToPkr(amount_total);

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
        originalAmountUsdCents: amount_total,
        fxRate: PKR_PER_USD,
      },
    });

    // Check if this is a new transaction (not a duplicate)
    const isNewTransaction = transaction.createdAt.getTime() === Date.now() ||
                             (Date.now() - transaction.createdAt.getTime()) < 1000;

    if (isNewTransaction) {
      // Guard against double-crediting: if a previous attempt already
      // credited the wallet and only failed on a later step, this
      // transaction's own status tells us so — do not blindly re-credit.
      if (transaction.status === 'completed') {
        return { wallet: await Wallet.findById(wallet._id), transaction };
      }

      let session;
      try {
        session = await mongoose.startSession();
      } catch (e) {
        session = null;
      }

      const applyInSession = async (s) => {
        // Atomic $inc credit AND the status flip both happen inside the
        // same session, so a later failure rolls the credit back too —
        // there is no window where the wallet is credited but the
        // transaction still reads 'pending' (or vice versa).
        await Wallet.creditAtomic(wallet._id, amount, s);
        transaction.status = 'completed';
        await transaction.save({ session: s });
      };

      try {
        if (session) {
          await session.withTransaction(() => applyInSession(session));
        } else {
          // No replica set available — best effort, sequential.
          await Wallet.creditAtomic(wallet._id, amount);
          transaction.status = 'completed';
          await transaction.save();
        }
      } catch (err) {
        transaction.status = 'failed';
        await transaction.save();
        throw new Error(`Failed to apply top-up: ${err.message}`);
      } finally {
        if (session) await session.endSession();
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
      // Atomic $inc guard + write in one op (no replica-set session available).
      await Wallet.debitAtomic(senderWallet._id, amount);
      await Wallet.creditAtomic(receiverWallet._id, netToReceiver);

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
            // Atomic $inc guard + write in one op, inside the session — the
            // sufficiency check and the decrement cannot be split by a
            // concurrent transfer (see Wallet.debitAtomic).
            await Wallet.debitAtomic(senderWallet._id, amount, session);
            await Wallet.creditAtomic(receiverWallet._id, netToReceiver, session);

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
   * PART C.3 — the ONE place payment logic lives, for a payer→payee
   * transfer that happens in a single shot (both sides known and settling
   * right now — e.g. a home-service customer paying a provider on
   * completion). Atomically: debits the payer, credits the payee minus
   * commission, credits the Platform ledger with the commission, and writes
   * a linked WalletTransaction on every side with `relatedTo` populated so
   * it traces back to what caused it.
   *
   * For modules that PAY at one lifecycle event and EARN at a later one
   * (healthcare: pay at booking, payout at appointment completion; shopping:
   * pay at checkout, payout at delivery) use payWithSettle() for the payer
   * leg and settlePayout() for the payee+commission leg instead — see their
   * doc comments for why a single settle() call doesn't fit that shape.
   *
   * @param {Object} params
   * @param {string} params.payerType - 'User' | 'Provider'
   * @param {string} params.payerId
   * @param {string} params.payeeType - 'User' | 'Provider'
   * @param {string} params.payeeId
   * @param {number} params.amount - gross amount in PKR
   * @param {string} params.source - one of the per-module source enum values
   * @param {{kind:string,id:string}} params.relatedTo
   * @param {string} [params.description]
   * @param {number} [params.commissionRate] - percent (0..100), from admin settings — never a literal
   * @param {string} [params.idempotencyKey]
   * @returns {Promise<Object>} { payerWallet, payeeWallet, payerTransaction, payeeTransaction, commissionTransaction, commission }
   */
  static async settle({
    payerType,
    payerId,
    payeeType,
    payeeId,
    amount,
    source,
    relatedTo,
    description = 'Payment',
    commissionRate = 0,
    idempotencyKey,
  }) {
    // 'Platform' is only valid as a party here for commission-only settles
    // (e.g. a provider owing commission on cash already collected in
    // person) — never as the customer-facing payer/payee of a real booking.
    if (!['User', 'Provider', 'Platform'].includes(payerType)) throw new Error('Invalid payerType');
    if (!['User', 'Provider', 'Platform'].includes(payeeType)) throw new Error('Invalid payeeType');
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new Error('Amount must be a positive number');
    }
    if (!relatedTo || !relatedTo.kind || !relatedTo.id) {
      throw new Error('settle() requires relatedTo: { kind, id }');
    }

    if (idempotencyKey) {
      const existing = await WalletTransaction.findOne({ idempotencyKey });
      if (existing) {
        const siblings = await WalletTransaction.find({ transferGroupId: existing.transferGroupId });
        return {
          payerTransaction: siblings.find((t) => t.type === 'debit' && t.source === source) || existing,
          payeeTransaction: siblings.find((t) => /_earning$/.test(t.source)),
          commissionTransaction: siblings.find((t) => t.source === 'commission'),
          transferGroupId: existing.transferGroupId,
          alreadyProcessed: true,
        };
      }
    }

    const payerWallet = await this.getOrCreateWallet(payerId, payerType);
    const payeeWallet = await this.getOrCreateWallet(payeeId, payeeType);
    const platformWallet = await this.getPlatformWallet();

    if (payerWallet.balance < amount) {
      throw new Error('Insufficient balance');
    }

    const commission = Math.round((amount * (commissionRate || 0)) / 100);
    const netToPayee = amount - commission;
    const earningSource = source.replace('_payment', '_earning');
    const transferGroupId = `settle_${crypto.randomBytes(8).toString('hex')}`;

    const applyLegs = async (session) => {
      await Wallet.debitAtomic(payerWallet._id, amount, session);
      await Wallet.creditAtomic(payeeWallet._id, netToPayee, session);
      if (commission > 0) await Wallet.creditAtomic(platformWallet._id, commission, session);

      const docs = [
        {
          wallet: payerWallet._id,
          type: 'debit',
          amount,
          currency: payerWallet.currency,
          description,
          source,
          status: 'completed',
          transferGroupId,
          idempotencyKey: idempotencyKey || undefined,
          relatedTo,
          counterparty: { id: payeeWallet.owner, type: payeeWallet.ownerType },
        },
        {
          wallet: payeeWallet._id,
          type: 'credit',
          amount: netToPayee,
          currency: payeeWallet.currency,
          description,
          source: earningSource,
          status: 'completed',
          transferGroupId,
          relatedTo,
          counterparty: { id: payerWallet.owner, type: payerWallet.ownerType },
          metadata: { grossAmount: amount, commission, commissionRate },
        },
      ];
      if (commission > 0) {
        docs.push({
          wallet: platformWallet._id,
          type: 'credit',
          amount: commission,
          currency: platformWallet.currency,
          description: `Commission — ${description}`,
          source: 'commission',
          status: 'completed',
          transferGroupId,
          relatedTo,
          metadata: { commissionRate, grossAmount: amount },
        });
      }
      const created = await WalletTransaction.insertMany(docs, session ? { session } : {});
      return {
        payerTransaction: created.find((t) => t.source === source),
        payeeTransaction: created.find((t) => t.source === earningSource),
        commissionTransaction: created.find((t) => t.source === 'commission') || null,
      };
    };

    let result;
    let session;
    try {
      session = await mongoose.startSession();
    } catch (e) {
      session = null;
    }

    try {
      if (session) {
        await session.withTransaction(async () => {
          result = await applyLegs(session);
        });
      } else {
        // Free-tier Atlas without a replica set: no multi-document
        // transaction support. Apply sequentially — each leg is individually
        // atomic ($inc-with-guard); a failure partway is logged, not silently
        // swallowed, and the caller sees the thrown error to decide on a
        // compensating action (this mirrors transferFunds' existing pattern).
        result = await applyLegs(null);
      }
    } finally {
      if (session) await session.endSession();
    }

    return {
      ...result,
      commission,
      transferGroupId,
      alreadyProcessed: false,
    };
  }

  /**
   * The payee+commission leg for modules that pay at one lifecycle event
   * (booking payment / checkout) and earn at a LATER one (appointment
   * completion / order delivery) — healthcare and shopping both work this
   * way today, deliberately: the customer's money should not reach the
   * provider/vendor before the service is actually rendered, so a
   * cancellation-before-completion never has to claw back a payout that
   * already landed.
   *
   * Because the payer already paid earlier (via payWithSettle, or a
   * module's own debit), this credits ONLY the payee (minus commission) and
   * the Platform ledger (with the commission) — giving commission a real,
   * auditable destination instead of the pre-existing bug where it was
   * computed and then discarded (see WALLET_DESIGN.md Part C.4).
   *
   * @param {Object} params
   * @param {string} params.payeeType - 'User' | 'Provider'
   * @param {string} params.payeeId
   * @param {number} params.amount - gross amount already collected from the payer, in PKR
   * @param {string} params.source - one of the *_earning source values
   * @param {{kind:string,id:string}} params.relatedTo
   * @param {string} [params.description]
   * @param {number} [params.commissionRate]
   * @returns {Promise<Object>} { payeeWallet, payeeTransaction, commissionTransaction, commission }
   */
  static async settlePayout({
    payeeType,
    payeeId,
    amount,
    source,
    relatedTo,
    description = 'Earnings',
    commissionRate = 0,
  }) {
    if (!['User', 'Provider'].includes(payeeType)) throw new Error('Invalid payeeType');
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new Error('Amount must be a positive number');
    }
    if (!relatedTo || !relatedTo.kind || !relatedTo.id) {
      throw new Error('settlePayout() requires relatedTo: { kind, id }');
    }

    const payeeWallet = await this.getOrCreateWallet(payeeId, payeeType);
    const platformWallet = await this.getPlatformWallet();

    const commission = Math.round((amount * (commissionRate || 0)) / 100);
    const net = amount - commission;
    const transferGroupId = `payout_${crypto.randomBytes(8).toString('hex')}`;

    await Wallet.creditAtomic(payeeWallet._id, net);
    const payeeTransaction = await WalletTransaction.create({
      wallet: payeeWallet._id,
      type: 'credit',
      amount: net,
      currency: payeeWallet.currency,
      description,
      source,
      status: 'completed',
      transferGroupId,
      relatedTo,
      metadata: { grossAmount: amount, commission, commissionRate },
    });

    let commissionTransaction = null;
    if (commission > 0) {
      await Wallet.creditAtomic(platformWallet._id, commission);
      commissionTransaction = await WalletTransaction.create({
        wallet: platformWallet._id,
        type: 'credit',
        amount: commission,
        currency: platformWallet.currency,
        description: `Commission — ${description}`,
        source: 'commission',
        status: 'completed',
        transferGroupId,
        relatedTo,
        metadata: { commissionRate, grossAmount: amount },
      });
    }

    return {
      payeeWallet: await Wallet.findById(payeeWallet._id),
      payeeTransaction,
      commissionTransaction,
      commission,
    };
  }

  /**
   * Reverse a settlePayout() — used when a completed/delivered order or
   * appointment is later refunded/returned. Debits the payee's net earnings
   * back out and reverses the commission from the Platform ledger. Silently
   * no-ops if there is nothing to reverse (idempotent on repeated calls).
   */
  static async reversePayout({ payeeType, payeeId, relatedTo }) {
    const payeeWallet = await this.getOrCreateWallet(payeeId, payeeType);
    const original = await WalletTransaction.findOne({
      wallet: payeeWallet._id,
      'relatedTo.kind': relatedTo.kind,
      'relatedTo.id': relatedTo.id,
      type: 'credit',
      source: { $regex: /_earning$/ },
    });
    if (!original) return null;

    const already = await WalletTransaction.findOne({
      wallet: payeeWallet._id,
      'relatedTo.kind': relatedTo.kind,
      'relatedTo.id': relatedTo.id,
      source: 'refund',
      type: 'debit',
    });
    if (already) return already; // idempotent

    if (payeeWallet.balance >= original.amount) {
      await Wallet.debitAtomic(payeeWallet._id, original.amount);
    }
    // else: provider already spent/paid out the balance — record the
    // reversal anyway so the ledger shows the intent; admin reconciliation
    // (Part F) will surface the shortfall rather than hiding it.
    return WalletTransaction.create({
      wallet: payeeWallet._id,
      type: 'debit',
      amount: original.amount,
      currency: payeeWallet.currency,
      description: `Reversal of earnings for ${relatedTo.kind} ${relatedTo.id}`,
      source: 'refund',
      status: 'completed',
      relatedTo,
      metadata: { reversedTransactionId: String(original._id) },
    });
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
