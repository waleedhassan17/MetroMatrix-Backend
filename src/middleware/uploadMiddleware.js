const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Local storage configuration (fallback when Cloudinary is not configured)
const localStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    let uploadPath = uploadsDir;
    
    // Create subdirectories based on file type
    if (file.fieldname === 'profilePhoto' || file.fieldname === 'avatar') {
      uploadPath = path.join(uploadsDir, 'avatars');
    } else if (file.fieldname === 'document' || file.fieldname.includes('License') || file.fieldname.includes('Certificate')) {
      uploadPath = path.join(uploadsDir, 'documents');
    } else if (file.fieldname === 'images' || file.fieldname === 'postImages') {
      uploadPath = path.join(uploadsDir, 'posts');
    }
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    // Generate unique filename
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext);
    cb(null, `${name}-${uniqueSuffix}${ext}`);
  },
});

// File filter
const fileFilter = (req, file, cb) => {
  // Define allowed file types for different fields
  const imageTypes = /jpeg|jpg|png|gif/;
  const documentTypes = /pdf|jpeg|jpg|png/;
  
  const ext = path.extname(file.originalname).toLowerCase();
  const mimetype = file.mimetype;
  
  // Check file type based on field name
  if (file.fieldname === 'profilePhoto' || file.fieldname === 'avatar' || file.fieldname === 'images' || file.fieldname === 'postImages') {
    // Image uploads
    if (imageTypes.test(ext) && imageTypes.test(mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files (jpg, jpeg, png, gif) are allowed'), false);
    }
  } else if (file.fieldname === 'document' || file.fieldname.includes('License') || file.fieldname.includes('Certificate') || file.fieldname === 'nationalIdCard') {
    // Document uploads
    if (documentTypes.test(ext) || mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and image files are allowed for documents'), false);
    }
  } else {
    // Default - allow common file types
    cb(null, true);
  }
};

// Create multer instances for different use cases
const uploadAvatar = multer({
  storage: localStorage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
  fileFilter,
}).single('profilePhoto');

const uploadDocument = multer({
  storage: localStorage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter,
}).single('document');

const uploadMultipleDocuments = multer({
  storage: localStorage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter,
}).fields([
  { name: 'medicalLicense', maxCount: 1 },
  { name: 'degreeCertificate', maxCount: 1 },
  { name: 'professionalCertificate', maxCount: 1 },
  { name: 'businessLicense', maxCount: 1 },
  { name: 'nationalIdCard', maxCount: 1 },
]);

const uploadPostImages = multer({
  storage: localStorage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB per file
    files: 5, // Maximum 5 images per post
  },
  fileFilter,
}).array('images', 5);

// Memory storage for temporary processing
const memoryStorage = multer.memoryStorage();

const uploadToMemory = multer({
  storage: memoryStorage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter,
});

// Error handling wrapper
const handleUploadError = (uploadFunction) => {
  return (req, res, next) => {
    uploadFunction(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            success: false,
            error: 'File size too large',
          });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({
            success: false,
            error: 'Too many files',
          });
        }
        return res.status(400).json({
          success: false,
          error: err.message,
        });
      } else if (err) {
        return res.status(400).json({
          success: false,
          error: err.message,
        });
      }
      next();
    });
  };
};

// Delete file utility
const deleteFile = (filePath) => {
  return new Promise((resolve, reject) => {
    fs.unlink(filePath, (err) => {
      if (err) {
        console.error('Error deleting file:', err);
        reject(err);
      } else {
        resolve();
      }
    });
  });
};

module.exports = {
  uploadAvatar: handleUploadError(uploadAvatar),
  uploadDocument: handleUploadError(uploadDocument),
  uploadMultipleDocuments: handleUploadError(uploadMultipleDocuments),
  uploadPostImages: handleUploadError(uploadPostImages),
  uploadToMemory,
  deleteFile,
  localStorage,
  memoryStorage,
};