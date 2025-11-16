const multer = require('multer');
const { uploadAvatar, uploadDocument, uploadPostImage } = require('../config/cloudinary');

// Error handling wrapper for upload middleware
const handleUploadError = (uploadFunction) => {
  return (req, res, next) => {
    uploadFunction(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        // Multer-specific errors
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            success: false,
            error: 'File size too large. Maximum size allowed is 5MB for images and 10MB for documents.',
          });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({
            success: false,
            error: 'Too many files. Maximum 5 images allowed per post.',
          });
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({
            success: false,
            error: 'Unexpected file field.',
          });
        }
        return res.status(400).json({
          success: false,
          error: err.message,
        });
      } else if (err) {
        // Other errors (file type, etc.)
        return res.status(400).json({
          success: false,
          error: err.message || 'File upload failed',
        });
      }
      next();
    });
  };
};

// Export configured upload middleware with error handling
module.exports = {
  // Single profile photo upload
  uploadProfilePhoto: handleUploadError(uploadAvatar.single('profilePhoto')),
  
  // Single document upload
  uploadSingleDocument: handleUploadError(uploadDocument.single('document')),
  
  // Multiple document fields for provider verification
  uploadMultipleDocuments: handleUploadError(
    uploadDocument.fields([
      { name: 'medicalLicense', maxCount: 1 },
      { name: 'degreeCertificate', maxCount: 1 },
      { name: 'professionalCertificate', maxCount: 1 },
      { name: 'businessLicense', maxCount: 1 },
      { name: 'nationalIdCard', maxCount: 1 },
    ])
  ),
  
  // Multiple post images (up to 5)
  uploadPostImages: handleUploadError(uploadPostImage.array('images', 5)),
  
  // Helper function to check if file was uploaded
  requireFile: (req, res, next) => {
    if (!req.file && !req.files) {
      return res.status(400).json({
        success: false,
        error: 'Please upload a file',
      });
    }
    next();
  },
};