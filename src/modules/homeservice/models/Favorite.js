const mongoose = require('mongoose');

// One document per customer holding the providers they saved, mirroring the
// shopping module's Wishlist. A single document (rather than one row per
// favourite) keeps the common read — "show me my favourites" — to one query,
// and the unique index on userId is what makes getOrCreate safe.
const favoriteSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    items: [
      {
        provider: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Provider',
          required: true,
        },
        addedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model('HSFavorite', favoriteSchema);
