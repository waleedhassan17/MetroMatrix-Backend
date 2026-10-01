const express = require('express');
const router = express.Router();
const {
  getSpecialties,
  createSpecialty,
  updateSpecialty,
  deleteSpecialty,
} = require('../controllers/adminSpecialtyController');
const { protect, adminOnly, requirePermission } = require('../middleware/authMiddleware');

// The specialty list is reference data every admin may read (it is also in
// GET /api/admin/meta); changing it is healthcare oversight.
const manage = requirePermission('canManageHealthcare');

router.get('/specialties', protect, adminOnly, getSpecialties);
router.post('/specialties', protect, adminOnly, manage, createSpecialty);
router.patch('/specialties/:id', protect, adminOnly, manage, updateSpecialty);
router.delete('/specialties/:id', protect, adminOnly, manage, deleteSpecialty);

module.exports = router;
