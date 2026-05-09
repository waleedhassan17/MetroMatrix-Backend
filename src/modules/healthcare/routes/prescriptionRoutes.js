const express = require('express');
const router = express.Router();
const {
  getMyPrescriptions,
  createPrescription,
  downloadPrescriptionPDF,
} = require('../controllers/prescriptionController');
const { requireUser, requireDoctor } = require('../middleware/healthcareAuth');

// Private - patient
router.get('/my', requireUser, getMyPrescriptions);
router.get('/:prescriptionId/pdf', requireUser, downloadPrescriptionPDF);

// Private - doctor
router.post('/', requireUser, requireDoctor, createPrescription);

module.exports = router;
