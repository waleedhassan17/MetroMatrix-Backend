const express = require('express');
const router = express.Router();
const {
  getPendingDoctors,
  approveDoctor,
  rejectDoctor,
  getAllDoctors,
} = require('../controllers/adminDoctorController');
const { protect, adminOnly } = require('../middleware/authMiddleware');

// All routes are admin only
router.get('/doctors/pending', protect, adminOnly, getPendingDoctors);
router.patch('/doctors/:doctorId/approve', protect, adminOnly, approveDoctor);
router.patch('/doctors/:doctorId/reject', protect, adminOnly, rejectDoctor);
router.get('/doctors', protect, adminOnly, getAllDoctors);

module.exports = router;