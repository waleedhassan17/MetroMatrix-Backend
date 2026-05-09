const express = require('express');
const router = express.Router();
const {
  getSpecialties,
  getSpecialty,
  createSpecialty,
  updateSpecialty,
  deleteSpecialty,
} = require('../controllers/specialtyController');
const { requireUser } = require('../middleware/healthcareAuth');

// Public routes
router.get('/', getSpecialties);
router.get('/:id', getSpecialty);

// Admin routes (authenticated — add admin middleware in production)
router.post('/', requireUser, createSpecialty);
router.put('/:id', requireUser, updateSpecialty);
router.delete('/:id', requireUser, deleteSpecialty);

module.exports = router;
