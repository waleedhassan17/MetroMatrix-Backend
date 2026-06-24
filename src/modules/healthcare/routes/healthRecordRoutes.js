const express = require('express');
const router = express.Router();
const {
  getMyRecords,
  createRecord,
  deleteRecord,
  updateRecord,
} = require('../controllers/healthRecordController');
const { requireUser } = require('../middleware/healthcareAuth');
const healthRecordUpload = require('../middleware/healthRecordUpload');

// All routes require authentication
router.use(requireUser);

// GET    /api/v1/healthcare/health-records          — List records
// POST   /api/v1/healthcare/health-records          — Create with file upload
// PUT    /api/v1/healthcare/health-records/:id       — Update metadata
// DELETE /api/v1/healthcare/health-records/:recordId — Delete record + files

router.get('/', getMyRecords);
router.post('/', healthRecordUpload, createRecord);
router.put('/:id', updateRecord);
router.delete('/:recordId', deleteRecord);

// Multer error handler (file size, file count, invalid type)
router.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      success: false,
      error: 'File size exceeds the 10MB limit',
    });
  }
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({
      success: false,
      error: 'Maximum 5 files allowed per upload',
    });
  }
  if (err.message && err.message.includes('Invalid file type')) {
    return res.status(400).json({
      success: false,
      error: err.message,
    });
  }
  next(err);
});

module.exports = router;
