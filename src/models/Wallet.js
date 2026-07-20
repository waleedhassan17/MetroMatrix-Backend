const mongoose = require('mongoose');
const { WALLET_CURRENCY } = require('../config/currency');

/**
 * Wallet Schema
 * Represents a wallet for either a User or Provider
 * Uses refPath to dynamically reference either User or Provider model
 */
const walletSchema = new mongoose.Schema(
  {
    /**
     * Owner reference - can be either User or Provider
     * refPath dynamically selects the model based on ownerType
     */
    // 'Platform' has no real referenced document (owner is a fixed sentinel
    // ObjectId — see WalletService.PLATFORM_OWNER_ID) so refPath is only
    // meaningful for User/Provider; population is skipped for Platform.
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      required: [true, 'Owner is required'],
      refPath: 'ownerType',
    },

    /**
     * Owner type - determines which model the owner references.
     * 'Platform' is the singleton commission ledger (Part C.4) — it has no
     * backing User/Provider document.
     */
    ownerType: {
      type: String,
      required: [true, 'Owner type is required'],
      enum: {
        values: ['User', 'Provider', 'Platform'],
        message: 'Owner type must be User, Provider or Platform',
      },
    },

    /**
     * Current wallet balance
     * Cannot be negative
     */
    balance: {
      type: Number,
      default: 0,
      min: [0, 'Balance cannot be negative'],
    },

    /**
     * Currency for the wallet
     * Stored in uppercase for consistency
     */
    currency: {
      type: String,
      default: WALLET_CURRENCY,
      uppercase: true,
    },
  },
  {
    timestamps: true,
  }
);

/**
 * Compound unique index on owner and ownerType
 * Ensures each user/provider has exactly one wallet
 */
walletSchema.index({ owner: 1, ownerType: 1 }, { unique: true });

/**
 * ATOMIC statics — the balance check AND the write happen in ONE MongoDB
 * operation, so two concurrent debits can never both read the same stale
 * balance and race each other. Use these (or the WalletService methods that
 * wrap them) for every balance mutation; do not read `.balance`, do math in
 * JS, then `.save()`.
 */
walletSchema.statics.creditAtomic = async function (walletId, amount, session = null) {
  if (!(amount > 0)) throw new Error('Credit amount must be positive');
  const opts = { new: true };
  if (session) opts.session = session;
  const wallet = await this.findOneAndUpdate(
    { _id: walletId },
    { $inc: { balance: amount } },
    opts
  );
  if (!wallet) throw new Error('Wallet not found');
  return wallet;
};

walletSchema.statics.debitAtomic = async function (walletId, amount, session = null) {
  if (!(amount > 0)) throw new Error('Debit amount must be positive');
  const opts = { new: true };
  if (session) opts.session = session;
  // The balance guard and the decrement happen in ONE operation, so a
  // concurrent debit cannot slip between the check and the write.
  const wallet = await this.findOneAndUpdate(
    { _id: walletId, balance: { $gte: amount } },
    { $inc: { balance: -amount } },
    opts
  );
  if (!wallet) {
    const exists = await this.exists({ _id: walletId });
    throw new Error(exists ? 'Insufficient balance' : 'Wallet not found');
  }
  return wallet;
};

walletSchema.statics.findOrCreate = async function (owner, ownerType, session = null) {
  const opts = { new: true, upsert: true, setDefaultsOnInsert: true };
  if (session) opts.session = session;
  return this.findOneAndUpdate(
    { owner, ownerType },
    { $setOnInsert: { owner, ownerType, balance: 0 } },
    opts
  );
};

/**
 * DEPRECATED instance methods — read-modify-write, kept only as thin
 * wrappers around the atomic statics so nothing crashes on deploy. New code
 * must call WalletService (which calls the statics above), never these.
 * @deprecated use Wallet.creditAtomic(walletId, amount) via WalletService
 */
walletSchema.methods.credit = async function (amount) {
  const updated = await this.constructor.creditAtomic(this._id, amount);
  this.balance = updated.balance;
  return this;
};

/**
 * @deprecated use Wallet.debitAtomic(walletId, amount) via WalletService
 */
walletSchema.methods.debit = async function (amount) {
  const updated = await this.constructor.debitAtomic(this._id, amount);
  this.balance = updated.balance;
  return this;
};

module.exports = mongoose.model('Wallet', walletSchema);
