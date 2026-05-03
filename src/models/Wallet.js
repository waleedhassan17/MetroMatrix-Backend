const mongoose = require('mongoose');

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
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      required: [true, 'Owner is required'],
      refPath: 'ownerType',
    },

    /**
     * Owner type - determines which model the owner references
     */
    ownerType: {
      type: String,
      required: [true, 'Owner type is required'],
      enum: {
        values: ['User', 'Provider'],
        message: 'Owner type must be either User or Provider',
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
      default: 'usd',
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
 * Credit method - adds funds to the wallet
 * @param {number} amount - Amount to credit (must be positive)
 * @returns {Promise<Wallet>} - Returns the saved wallet document
 * @throws {Error} - If amount is not positive
 */
walletSchema.methods.credit = async function (amount) {
  if (amount <= 0) {
    throw new Error('Credit amount must be positive');
  }
  
  this.balance += amount;
  return await this.save();
};

/**
 * Debit method - removes funds from the wallet
 * @param {number} amount - Amount to debit (must be positive)
 * @returns {Promise<Wallet>} - Returns the saved wallet document
 * @throws {Error} - If amount is not positive or if insufficient balance
 */
walletSchema.methods.debit = async function (amount) {
  if (amount <= 0) {
    throw new Error('Debit amount must be positive');
  }
  
  if (this.balance < amount) {
    throw new Error('Insufficient balance');
  }
  
  this.balance -= amount;
  return await this.save();
};

module.exports = mongoose.model('Wallet', walletSchema);
