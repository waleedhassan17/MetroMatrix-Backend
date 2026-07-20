const mongoose = require('mongoose');

const providerReviewSchema = new mongoose.Schema(
  {
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'HSBooking',
      required: true,
      unique: true, // one review per booking
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    provider: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Provider',
      required: true,
      index: true,
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
      validate: {
        validator: Number.isInteger,
        message: 'Rating must be an integer between 1 and 5',
      },
    },
    comment: { type: String, maxlength: 1000, default: '' },
    tags: [String],
  },
  { timestamps: true }
);

module.exports = mongoose.model('HSProviderReview', providerReviewSchema);
