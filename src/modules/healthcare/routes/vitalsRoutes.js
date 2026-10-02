const express = require('express');
const router = express.Router();
const { requireUser } = require('../middleware/healthcareAuth');
const { userOnly } = require('../../../middleware/authMiddleware');
const { getMyVitals, addVitals, deleteVital } = require('../controllers/vitalsController');

// Patient's own vital signs (Bluetooth monitors or typed in).
router.use(requireUser, userOnly);
router.get('/', getMyVitals);
router.post('/', addVitals);
router.delete('/:id', deleteVital);

module.exports = router;
