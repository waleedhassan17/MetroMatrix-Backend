const mongoose = require('mongoose');
const Review = require('../models/Review');
const Doctor = require('../models/Doctor');

/**
 * Privacy-safe name formatter.
 * "Ali Khan" → "Ali K."
 * "Muhammad" → "Muhammad"
 */
const formatPrivacyName = (fullName) => {
  if (!fullName) return 'Anonymous';
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
};

/**
 * Get reviews for a doctor with rating breakdown.
 * @param {string} doctorId
 * @param {Object} filters - { rating }
 * @param {Object} options - { page, limit }
 */
const getDoctorReviews = async (doctorId, filters = {}, options = {}) => {
  const { rating } = filters;
  const { page = 1, limit = 10 } = options;
  const skip = (page - 1) * Number(limit);

  const docId = new mongoose.Types.ObjectId(doctorId);

  // Build query
  const query = { doctorId: docId };
  if (rating) query.rating = Number(rating);

  // Run reviews fetch + rating breakdown aggregation in parallel
  const [reviews, totalCount, breakdown] = await Promise.all([
    // Paginated reviews
    Review.find(query)
      .populate('patientId', 'fullName displayName avatar')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean(),

    // Total matching reviews
    Review.countDocuments(query),

    // Rating breakdown aggregation (always for ALL reviews of this doctor)
    Review.aggregate([
      { $match: { doctorId: docId } },
      {
        $facet: {
          overall: [
            {
              $group: {
                _id: null,
                average: { $avg: '$rating' },
                total: { $sum: 1 },
              },
            },
          ],
          byRating: [
            {
              $group: {
                _id: '$rating',
                count: { $sum: 1 },
              },
            },
          ],
        },
      },
    ]),
  ]);

  // Format rating breakdown
  const overallStats = breakdown[0]?.overall[0] || { average: 0, total: 0 };
  const ratingCounts = {};
  [1, 2, 3, 4, 5].forEach((r) => { ratingCounts[r] = 0; });
  (breakdown[0]?.byRating || []).forEach((item) => {
    ratingCounts[item._id] = item.count;
  });

  const ratingBreakdown = {
    average: Math.round((overallStats.average || 0) * 10) / 10,
    total: overallStats.total,
    ...ratingCounts,
  };

  // Privacy-safe name formatting
  const safeReviews = reviews.map((review) => {
    const patientName = review.patientId?.displayName
      || review.patientId?.fullName
      || 'Anonymous';

    return {
      id: review._id,
      rating: review.rating,
      comment: review.comment,
      createdAt: review.createdAt,
      patient: {
        name: formatPrivacyName(patientName),
        avatar: review.patientId?.avatar || null,
      },
    };
  });

  return {
    reviews: safeReviews,
    ratingBreakdown,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total: totalCount,
      pages: Math.ceil(totalCount / Number(limit)),
    },
  };
};

/**
 * Create a review and recalculate doctor's rating.
 * Uses the running average formula instead of re-aggregating.
 */
const createReview = async (data) => {
  const { appointmentId, doctorId, patientId, rating, comment } = data;

  // Create the review
  const review = await Review.create({
    appointmentId,
    doctorId,
    patientId,
    rating,
    comment: comment || '',
  });

  // Recalculate doctor rating with running average formula
  const doctor = await Doctor.findById(doctorId);
  if (doctor) {
    const newRating =
      ((doctor.rating * doctor.totalReviews) + rating) /
      (doctor.totalReviews + 1);

    doctor.rating = Math.round(newRating * 10) / 10;
    doctor.totalReviews += 1;
    await doctor.save();
  }

  return review;
};

module.exports = { getDoctorReviews, createReview, formatPrivacyName };
