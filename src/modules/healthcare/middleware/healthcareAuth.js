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
    // A doctor is a Provider with providerType 'doctor' and a linked Doctor profile.
    const doctor = await Doctor.findOne({ providerId: req.user._id });

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

/**
 * requireAdmin - Ensures the authenticated account is an Admin.
 * Reuses the same detection the main authMiddleware performs (protect sets
 * req.isAdmin); no new auth mechanism.
 */
const requireAdmin = [
  protect,
  (req, res, next) => {
    if (!req.isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Admin privileges required.',
      });
    }
    next();
  },
];

/**
 * requireAppointmentParticipant - loads req.appointment and verifies the
 * caller is the patient, the owning doctor, or an admin. PHI guard.
 * Route must carry :appointmentId (or :id).
 */
const requireAppointmentParticipant = async (req, res, next) => {
  try {
    const Appointment = require('../models/Appointment');
    const Doctor = require('../models/Doctor');
    const appointmentId = req.params.appointmentId || req.params.id;
    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return res.status(404).json({ success: false, error: 'Appointment not found' });
    }
    if (req.isAdmin) {
      req.appointment = appointment;
      return next();
    }
    if (appointment.patientId.toString() === req.user._id.toString()) {
      req.appointment = appointment;
      return next();
    }
    const doctor = await Doctor.findOne({ providerId: req.user._id });
    if (doctor && appointment.doctorId.toString() === doctor._id.toString()) {
      req.appointment = appointment;
      req.doctor = doctor;
      return next();
    }
    return res.status(403).json({ success: false, error: 'Access denied' });
  } catch (error) {
    next(error);
  }
};

/**
 * requireRecordOwner - loads req.record and verifies the caller owns the
 * health record. PHI guard. Route must carry :recordId (or :id).
 */
const requireRecordOwner = async (req, res, next) => {
  try {
    const HealthRecord = require('../models/HealthRecord');
    const recordId = req.params.recordId || req.params.id;
    const record = await HealthRecord.findById(recordId);
    if (!record) {
      return res.status(404).json({ success: false, error: 'Health record not found' });
    }
    if (record.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Access denied. This record does not belong to you.',
      });
    }
    req.record = record;
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * requireTreatingDoctor - the caller must be a doctor who has at least one
 * appointment with :patientId. Prevents any doctor from pulling an arbitrary
 * patient's identity/notes/history by guessing ids. PHI guard.
 * Must run AFTER protect/providerOnly. Sets req.doctor.
 */
const requireTreatingDoctor = async (req, res, next) => {
  try {
    const Doctor = require('../models/Doctor');
    const Appointment = require('../models/Appointment');
    const doctor = await Doctor.findOne({ providerId: req.user._id });
    if (!doctor) {
      return res.status(403).json({ success: false, error: 'Doctor profile required' });
    }
    const patientId = req.params.patientId || req.body.patientId;
    if (!patientId) {
      return res.status(400).json({ success: false, error: 'patientId is required' });
    }
    const relationship = await Appointment.findOne({
      doctorId: doctor._id,
      patientId,
    }).select('_id');
    if (!relationship) {
      return res.status(403).json({
        success: false,
        error: 'Access denied. You have no appointment with this patient.',
      });
    }
    req.doctor = doctor;
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = {
  requireUser,
  requireDoctor,
  requireAdmin,
  requireAppointmentParticipant,
  requireRecordOwner,
  requireTreatingDoctor,
  protect,
};
