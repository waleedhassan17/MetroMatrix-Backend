const express = require('express');
const router = express.Router();
const {
  reviewValidationRules,
  handleValidationErrors,
  getDoctorReviews,
  createReview,
} = require('../controllers/reviewController');
const { requireUser } = require('../middleware/healthcareAuth');

// Public
router.get('/doctor/:doctorId', getDoctorReviews);

// Private
router.post('/', requireUser, reviewValidationRules, handleValidationErrors, createReview);

module.exports = router;
