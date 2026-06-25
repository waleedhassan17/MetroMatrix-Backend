const Prescription = require('../models/Prescription');

const createPrescription = async (data) => {
  return Prescription.create(data);
};

const getPrescriptionByAppointment = async (appointmentId) => {
  return Prescription.findOne({ appointmentId })
    .populate({ path: 'doctorId', populate: [{ path: 'providerId', select: 'fullName profilePhoto' }, { path: 'specialtyId', select: 'name' }] })
    .populate('patientId', 'fullName email');
};

const getPatientPrescriptions = async (patientId, options = {}) => {
  const { page = 1, limit = 10 } = options;
  return Prescription.find({ patientId })
    .populate({ path: 'doctorId', populate: [{ path: 'providerId', select: 'fullName profilePhoto' }, { path: 'specialtyId', select: 'name' }] })
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit);
};

module.exports = { createPrescription, getPrescriptionByAppointment, getPatientPrescriptions };
