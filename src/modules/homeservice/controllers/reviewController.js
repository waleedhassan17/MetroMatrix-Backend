const asyncHandler = require('express-async-handler');
const Booking = require('../models/Booking');
const ProviderReview = require('../models/ProviderReview');
const Provider = require('../../../models/Provider');
const { STATUS } = require('../services/statusMap');
const { avatar, SUBTYPE_TO_CATEGORY } = require('../services/serializers');

const ok = (res, data, message) => res.json({ success: true, data, message });

const REVIEW_TAGS = [
  { id: '1', label: 'Professional', icon: 'star' },
  { id: '2', label: 'On Time', icon: 'time' },
  { id: '3', label: 'Good Value', icon: 'wallet' },
  { id: '4', label: 'Friendly', icon: 'happy' },
  { id: '5', label: 'Expert', icon: 'ribbon' },
  { id: '6', label: 'Clean Work', icon: 'sparkles' },
];

// GET /api/reviews/:bookingId/init — ReviewData for the rating screen
const initReview = asyncHandler(async (req, res) => {
  const b = req.booking;
  ok(res, {
    provider: {
      id: String(b.provider._id),
      name: b.provider.fullName,
      image: avatar(b.provider.fullName, b.provider.profilePhoto),
      category: SUBTYPE_TO_CATEGORY[b.provider.providerSubType] || 'electricians',
    },
    serviceDetails: {
      type: b.serviceSubCategory || b.serviceCategory,
      description: b.description || b.instructions || '',
      completedAt: b.work.endedAt ? b.work.endedAt.toISOString() : '',
      amount: b.pricing.finalPrice || b.pricing.estimatedPrice,
    },
    availableTags: REVIEW_TAGS,
  }, 'Review data fetched');
});

// POST /api/reviews — { bookingId, providerId, rating, feedback, tags[] }
// Only the customer, only when COMPLETED, only once per booking.
const submitReview = asyncHandler(async (req, res) => {
  const { bookingId, rating, feedback, tags } = req.body;
  const ratingN = Number(rating);
  if (!Number.isInteger(ratingN) || ratingN < 1 || ratingN > 5) {
    res.status(400);
    throw new Error('Rating must be an integer between 1 and 5');
  }

  const booking = await Booking.findById(bookingId);
  if (!booking) {
    res.status(404);
    throw new Error('Booking not found');
  }
  if (String(booking.customer) !== String(req.user._id)) {
    res.status(403);
    throw new Error('Only the booking customer can review');
  }
  if (booking.status !== STATUS.COMPLETED) {
    res.status(400);
    throw new Error('You can only review a completed booking');
  }

  let review;
  try {
    review = await ProviderReview.create({
      booking: booking._id,
      customer: req.user._id,
      provider: booking.provider,
      rating: ratingN,
      comment: feedback || '',
      tags: Array.isArray(tags) ? tags : [],
    });
  } catch (e) {
    if (e.code === 11000) {
      res.status(400);
      throw new Error('This booking has already been reviewed');
    }
    throw e;
  }

  // ATOMIC rating recompute — single pipeline update, no read-modify-write.
  await Provider.updateOne({ _id: booking.provider }, [
    {
      $set: {
        'ratings.count': { $add: [{ $ifNull: ['$ratings.count', 0] }, 1] },
        'ratings.average': {
          $round: [
            {
              $divide: [
                {
                  $add: [
                    {
                      $multiply: [
                        { $ifNull: ['$ratings.average', 0] },
                        { $ifNull: ['$ratings.count', 0] },
                      ],
                    },
                    ratingN,
                  ],
                },
                { $add: [{ $ifNull: ['$ratings.count', 0] }, 1] },
              ],
            },
            2,
          ],
        },
        [`ratings.breakdown.${ratingN}`]: {
          $add: [{ $ifNull: [`$ratings.breakdown.${ratingN}`, 0] }, 1],
        },
      },
    },
  ]);

  ok(res, {
    id: String(review._id),
    rating: review.rating,
    feedback: review.comment,
    tags: review.tags,
    createdAt: review.createdAt.toISOString(),
  }, 'Review submitted successfully');
});

module.exports = { initReview, submitReview };
