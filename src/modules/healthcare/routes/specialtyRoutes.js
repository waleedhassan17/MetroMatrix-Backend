const express = require('express');
const router = express.Router();
const {
  getSpecialties,
  getSpecialty,
  createSpecialty,
  updateSpecialty,
  deleteSpecialty,
} = require('../controllers/specialtyController');
const { requireAdmin } = require('../middleware/healthcareAuth');

// Public routes
router.get('/', getSpecialties);
router.get('/:id', getSpecialty);

// Admin-only mutations. Previously guarded with requireUser, which let ANY
// authenticated patient create/edit/delete a medical specialty (SECURITY_FIXES.md #1).
router.post('/', requireAdmin, createSpecialty);
router.put('/:id', requireAdmin, updateSpecialty);
router.delete('/:id', requireAdmin, deleteSpecialty);

module.exports = router;
