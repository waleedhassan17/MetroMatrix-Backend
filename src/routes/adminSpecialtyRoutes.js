const express = require('express');
const router = express.Router();
const {
  getSpecialties,
  createSpecialty,
  updateSpecialty,
  deleteSpecialty,
} = require('../controllers/adminSpecialtyController');
const { protect, adminOnly } = require('../middleware/authMiddleware');

router.get('/specialties', protect, adminOnly, getSpecialties);
router.post('/specialties', protect, adminOnly, createSpecialty);
router.patch('/specialties/:id', protect, adminOnly, updateSpecialty);
router.delete('/specialties/:id', protect, adminOnly, deleteSpecialty);

module.exports = router;