const express = require('express');
const router = express.Router();
const { requireUser } = require('../middleware/healthcareAuth');
const { checkSymptoms } = require('../controllers/symptomCheckerController');

router.post('/', requireUser, checkSymptoms);

module.exports = router;
