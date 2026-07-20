const express = require('express');
const router = express.Router();
const {
  getSpecialties,
  createSpecialty,
  updateSpecialty,
  deleteSpecialty,
} = require('../controllers/adminSpecialtyController');
const { protect, adminOnly, requirePermission } = require('../middleware/authMiddleware');

router.get('/specialties', protect, adminOnly, getSpecialties);
router.post('/specialties', protect, adminOnly, requirePermission('canManageHealthcare'), createSpecialty);
router.patch('/specialties/:id', protect, adminOnly, requirePermission('canManageHealthcare'), updateSpecialty);
router.delete('/specialties/:id', protect, adminOnly, requirePermission('canManageHealthcare'), deleteSpecialty);

module.exports = router;