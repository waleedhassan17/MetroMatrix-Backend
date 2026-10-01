const express = require('express');
const router = express.Router();
const {
  getPendingDoctors,
  approveDoctor,
  rejectDoctor,
  getAllDoctors,
} = require('../controllers/adminDoctorController');
const { protect, adminOnly, requirePermission } = require('../middleware/authMiddleware');

// Doctor review is healthcare oversight: reads (doctor profiles, licences)
// and decisions alike need canManageHealthcare.
const healthcare = [protect, adminOnly, requirePermission('canManageHealthcare')];

router.get('/doctors/pending', healthcare, getPendingDoctors);
router.patch('/doctors/:doctorId/approve', healthcare, approveDoctor);
router.patch('/doctors/:doctorId/reject', healthcare, rejectDoctor);
router.get('/doctors', healthcare, getAllDoctors);

module.exports = router;
