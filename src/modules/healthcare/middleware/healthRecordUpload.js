/**
 * Health Record File Upload Middleware
 *
 * Uses Cloudinary + Multer for file storage.
 * - Allowed: JPEG, PNG, PDF
 * - Max size: 10MB per file
 * - Max files: 5 per request
 * - Cloudinary folder: metromatrix/health-records/{userId}
 */
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { cloudinary } = require('../../../config/cloudinary');

const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: `metromatrix/health-records/${req.user._id}`,
    resource_type: file.mimetype === 'application/pdf' ? 'raw' : 'image',
    allowed_formats: ['jpg', 'jpeg', 'png', 'pdf'],
    public_id: `hr-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
  }),
});

const fileFilter = (req, file, cb) => {
  const allowedMimes = ['image/jpeg', 'image/png', 'application/pdf'];
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error('Invalid file type. Only JPEG, PNG, and PDF files are allowed.'),
      false
    );
  }
};

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter,
});

// Export as array upload middleware (field name: 'files', max: 5)
module.exports = upload.array('files', 5);
