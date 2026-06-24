const { body, validationResult } = require('express-validator');
const reviewService = require('../services/reviewService');
const Appointment = require('../models/Appointment');
const Review = require('../models/Review');

// ─── Validation ─────────────────────────────────────
const reviewValidationRules = [
  body('appointmentId')
    .notEmpty().withMessage('appointmentId is required')
    .isMongoId().withMessage('appointmentId must be a valid ID'),
  body('rating')
    .notEmpty().withMessage('rating is required')
    .isInt({ min: 1, max: 5 }).withMessage('rating must be between 1 and 5'),
  body('comment')
    .optional()
    .isString()
    .isLength({ max: 1000 }).withMessage('Comment cannot exceed 1000 characters'),
];

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors.array().map((e) => ({ field: e.path, message: e.msg })),
    });
  }
  next();
};

// ═══════════════════════════════════════════════════════
//  API 1: GET /doctors/:doctorId/reviews  [Public]
// ═══════════════════════════════════════════════════════

// @desc    Get reviews for a doctor with rating breakdown
// @route   GET /api/v1/healthcare/doctors/:doctorId/reviews
// @access  Public
const getDoctorReviews = async (req, res, next) => {
  try {
    const { rating, page = 1, limit = 10 } = req.query;

    // Validate rating filter
    if (rating && (Number(rating) < 1 || Number(rating) > 5)) {
      return res.status(400).json({
        success: false,
        error: 'rating must be between 1 and 5',
      });
    }

    const result = await reviewService.getDoctorReviews(
      req.params.doctorId,
      { rating },
      { page: Number(page), limit: Number(limit) }
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({ success: false, error: 'Invalid doctor ID' });
    }
    next(error);
  }
};

// ═══════════════════════════════════════════════════════
//  API 2: POST /reviews  [requireUser]
// ═══════════════════════════════════════════════════════

// @desc    Submit a review for a completed appointment
// @route   POST /api/v1/healthcare/reviews
// @access  Private
const createReview = async (req, res, next) => {
  try {
    const { appointmentId, rating, comment } = req.body;

    // 1. Load appointment and verify ownership
    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return res.status(404).json({ success: false, error: 'Appointment not found' });
    }

    if (appointment.patientId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'You can only review your own appointments',
      });
    }

    // 2. Verify appointment is completed
    if (appointment.status !== 'completed') {
      return res.status(400).json({
        success: false,
        error: 'You can only review completed appointments',
      });
    }

    // 3. Check for existing review
    const existing = await Review.findOne({ appointmentId });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'You have already reviewed this appointment',
      });
    }

    // 4-6. Create review + recalculate doctor rating
    const review = await reviewService.createReview({
      appointmentId,
      doctorId: appointment.doctorId,
      patientId: req.user._id,
      rating: Number(rating),
      comment,
    });

    res.status(201).json({
      success: true,
      message: 'Review submitted successfully',
      data: review,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        error: 'A review for this appointment already exists',
      });
    }
    next(error);
  }
};

module.exports = {
  reviewValidationRules,
  handleValidationErrors,
  getDoctorReviews,
  createReview,
};
