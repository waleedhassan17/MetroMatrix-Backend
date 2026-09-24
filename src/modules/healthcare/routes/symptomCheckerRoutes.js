const express = require('express');
const router = express.Router();
const { requireUser } = require('../middleware/healthcareAuth');
const { checkSymptoms, chatCheckSymptoms } = require('../controllers/symptomCheckerController');

router.post('/', requireUser, checkSymptoms);
router.post('/chat', requireUser, chatCheckSymptoms);

module.exports = router;
