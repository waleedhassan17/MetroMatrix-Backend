const express = require('express');
const router = express.Router();
const {
  getMyPrescriptions,
  getPrescriptionById,
  createPrescription,
  downloadPrescriptionPDF,
} = require('../controllers/prescriptionController');
const { requireUser, requireDoctor } = require('../middleware/healthcareAuth');

// Private - the patient it belongs to, or the doctor who wrote it. The
// controller enforces that; requireUser only proves who is asking.
//
// '/my' MUST stay above '/:prescriptionId' — Express matches in declaration
// order, so otherwise "my" would be captured as a prescription id.
router.get('/my', requireUser, getMyPrescriptions);
router.get('/:prescriptionId/pdf', requireUser, downloadPrescriptionPDF);
router.get('/:prescriptionId', requireUser, getPrescriptionById);

// Private - doctor
router.post('/', requireUser, requireDoctor, createPrescription);

module.exports = router;
