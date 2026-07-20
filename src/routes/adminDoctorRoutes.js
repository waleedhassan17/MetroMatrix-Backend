const express = require('express');
const router = express.Router();
const {
  getPendingDoctors,
  approveDoctor,
  rejectDoctor,
  getAllDoctors,
} = require('../controllers/adminDoctorController');
const { protect, adminOnly, requirePermission } = require('../middleware/authMiddleware');

// Reads open to any admin; approve/reject requires canManageHealthcare
// (previously only checked isAdmin — the permission was stored on Admin
// but never enforced here, confirmed live during the Prompt 6 sweep).
router.get('/doctors/pending', protect, adminOnly, getPendingDoctors);
router.patch('/doctors/:doctorId/approve', protect, adminOnly, requirePermission('canManageHealthcare'), approveDoctor);
router.patch('/doctors/:doctorId/reject', protect, adminOnly, requirePermission('canManageHealthcare'), rejectDoctor);
router.get('/doctors', protect, adminOnly, getAllDoctors);

module.exports = router;