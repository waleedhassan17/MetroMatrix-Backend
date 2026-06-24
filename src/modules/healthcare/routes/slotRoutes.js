const express = require('express');
const router = express.Router();
const { getSlots, createSlots, updateSlot, deleteSlot, getMySlots } = require('../controllers/slotController');
const { requireUser, requireDoctor } = require('../middleware/healthcareAuth');

// Doctor-only routes (must come before :doctorId param)
router.get('/my-slots', requireUser, requireDoctor, getMySlots);

// Public
router.get('/:doctorId', getSlots);

// Private - doctor only
router.post('/', requireUser, requireDoctor, createSlots);
router.put('/:id', requireUser, requireDoctor, updateSlot);
router.delete('/:id', requireUser, requireDoctor, deleteSlot);

module.exports = router;
