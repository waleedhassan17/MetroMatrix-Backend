/**
 * Healthcare Auth Middleware
 * Reuses the existing protect middleware from the main app
 * and adds a convenience wrapper for healthcare routes.
 */
const { protect } = require('../../../middleware/authMiddleware');

/**
 * requireUser - Ensures the request has a valid authenticated user.
 * Wraps the existing protect middleware + verifies req.user exists.
 */
const requireUser = [
  protect,
  (req, res, next) => {
    if (!req.user) {
      res.status(401);
      throw new Error('Authentication required');
    }
    next();
  },
];

/**
 * requireDoctor - Ensures the authenticated user is a verified doctor.
 * Must be used AFTER requireUser.
 */
const requireDoctor = async (req, res, next) => {
  try {
    const Doctor = require('../models/Doctor');
    const doctor = await Doctor.findOne({ userId: req.user._id });

    if (!doctor) {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Doctor profile required.',
      });
    }

    if (doctor.verificationStatus !== 'verified') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Doctor profile is not verified.',
      });
    }

    req.doctor = doctor;
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = { requireUser, requireDoctor, protect };
