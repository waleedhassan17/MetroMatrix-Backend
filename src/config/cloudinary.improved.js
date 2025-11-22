const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Test Cloudinary connection
const testCloudinaryConnection = async () => {
  try {
    await cloudinary.api.ping();
    console.log('✅ Cloudinary connected successfully'.green);
    return true;
  } catch (error) {
    console.error('❌ Cloudinary connection failed:'.red, error.message);
    return false;
  }
};

// Error handling
const handleUploadError = (error, reject) => {
  console.error('Cloudinary upload error:', error);
  if (error.message.includes('Invalid image file')) {
    reject(new Error('Please upload a valid image file'));
  } else if (error.message.includes('File size')) {
    reject(new Error('File size exceeds the maximum limit'));
  } else {
    reject(new Error('File upload failed. Please try again'));
  }
};

/**
 * Create Cloudinary storage with organized folder structure
 * @param {string} entityType - 'user', 'provider', or 'post'
 * @param {string} subFolder - Specific subfolder within entity type
 * @param {string} resourceType - 'image', 'raw', or 'auto'
 * @returns {CloudinaryStorage} Configured storage instance
 */
const createOrganizedStorage = (entityType, subFolder, resourceType = 'auto') => {
  return new CloudinaryStorage({
    cloudinary: cloudinary,
    params: async (req, file) => {
      let folder = '';
      let allowedFormats = [];
      let transformation = [];
      
      // Determine folder structure and settings based on entity type
      switch(entityType) {
        case 'user':
          folder = `metromatrix/users/${subFolder}`;
          if (subFolder === 'profiles') {
            allowedFormats = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
            transformation = [{ width: 500, height: 500, crop: 'limit', quality: 'auto' }];
          }
          break;
          
        case 'provider':
          const providerType = req.body.providerType || req.user?.providerType || 'general';
          
          if (subFolder === 'profiles') {
            folder = `metromatrix/providers/profiles`;
            allowedFormats = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
            transformation = [{ width: 500, height: 500, crop: 'limit', quality: 'auto' }];
          } else {
            // Document uploads organized by provider type
            folder = `metromatrix/providers/${providerType}/${subFolder}`;
            allowedFormats = ['pdf', 'jpg', 'jpeg', 'png'];
          }
          break;
          
        case 'post':
          folder = `metromatrix/posts/${subFolder}`;
          allowedFormats = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
          transformation = [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto' }];
          break;
          
        default:
          folder = `metromatrix/misc`;
      }

      return {
        folder: folder,
        allowed_formats: allowedFormats,
        resource_type: resourceType,
        transformation: transformation.length > 0 ? transformation : undefined,
        public_id: `${Date.now()}-${Math.round(Math.random() * 1e9)}`,
      };
    },
  });
};

// ===== USER UPLOADS =====

// User profile photos
const userProfileStorage = createOrganizedStorage('user', 'profiles', 'image');

const uploadUserProfile = multer({
  storage: userProfileStorage,
  limits: { 
    fileSize: 5 * 1024 * 1024, // 5MB
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Allowed: ${allowedTypes.join(', ')}`), false);
    }
  },
});

// ===== PROVIDER UPLOADS =====

// Provider profile photos
const providerProfileStorage = createOrganizedStorage('provider', 'profiles', 'image');

const uploadProviderProfile = multer({
  storage: providerProfileStorage,
  limits: { 
    fileSize: 5 * 1024 * 1024, // 5MB
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Allowed: ${allowedTypes.join(', ')}`), false);
    }
  },
});

// Provider documents (organized by type)
const createProviderDocumentStorage = (documentType) => {
  return createOrganizedStorage('provider', documentType, 'auto');
};

const uploadProviderDocument = (documentType) => {
  return multer({
    storage: createProviderDocumentStorage(documentType),
    limits: { 
      fileSize: 10 * 1024 * 1024, // 10MB
      files: 1
    },
    fileFilter: (req, file, cb) => {
      const allowedTypes = [
        'application/pdf',
        'image/jpeg',
        'image/jpg',
        'image/png',
      ];
      if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`Invalid file type. Allowed: ${allowedTypes.join(', ')}`), false);
      }
    },
  });
};

// Specific document type uploads
const uploadMedicalLicense = uploadProviderDocument('medical-licenses');
const uploadDegreeCertificate = uploadProviderDocument('degree-certificates');
const uploadProfessionalCertificate = uploadProviderDocument('professional-certificates');
const uploadBusinessLicense = uploadProviderDocument('business-licenses');
const uploadNationalId = uploadProviderDocument('national-ids');

// ===== POST UPLOADS =====

// Post images
const postImageStorage = createOrganizedStorage('post', 'images', 'image');

const uploadPostImages = multer({
  storage: postImageStorage,
  limits: { 
    fileSize: 5 * 1024 * 1024, // 5MB per file
    files: 5 // Maximum 5 images
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Allowed: ${allowedTypes.join(', ')}`), false);
    }
  },
});

// ===== FILE MANAGEMENT =====

// Delete single file
const deleteFile = async (publicId) => {
  try {
    if (!publicId) {
      console.warn('No publicId provided for deletion');
      return { result: 'ok' };
    }

    const result = await cloudinary.uploader.destroy(publicId);
    console.log(`File deleted from Cloudinary: ${publicId}`, result);
    return result;
  } catch (error) {
    console.error('Error deleting file from Cloudinary:', error);
    throw error;
  }
};

// Delete multiple files
const deleteFiles = async (publicIds) => {
  try {
    const results = await Promise.all(
      publicIds.map(publicId => deleteFile(publicId))
    );
    return results;
  } catch (error) {
    console.error('Error deleting multiple files from Cloudinary:', error);
    throw error;
  }
};

// Delete entire folder
const deleteFolder = async (folderPath) => {
  try {
    await cloudinary.api.delete_resources_by_prefix(folderPath);
    await cloudinary.api.delete_folder(folderPath);
    console.log(`Folder deleted from Cloudinary: ${folderPath}`);
    return { result: 'ok' };
  } catch (error) {
    console.error('Error deleting folder from Cloudinary:', error);
    throw error;
  }
};

// Upload base64 image
const uploadBase64Image = async (base64String, entityType, subFolder) => {
  try {
    const folder = `metromatrix/${entityType}/${subFolder}`;
    const result = await cloudinary.uploader.upload(base64String, {
      folder: folder,
      resource_type: 'auto',
    });
    return {
      url: result.secure_url,
      publicId: result.public_id,
    };
  } catch (error) {
    console.error('Error uploading base64 image:', error);
    throw error;
  }
};

// Get file info
const getFileInfo = async (publicId) => {
  try {
    const result = await cloudinary.api.resource(publicId);
    return result;
  } catch (error) {
    console.error('Error getting file info:', error);
    throw error;
  }
};

module.exports = {
  cloudinary,
  
  // User uploads
  uploadUserProfile,
  
  // Provider uploads
  uploadProviderProfile,
  uploadMedicalLicense,
  uploadDegreeCertificate,
  uploadProfessionalCertificate,
  uploadBusinessLicense,
  uploadNationalId,
  uploadProviderDocument,
  
  // Post uploads
  uploadPostImages,
  
  // File management
  deleteFile,
  deleteFiles,
  deleteFolder,
  uploadBase64Image,
  getFileInfo,
  
  // Utilities
  testCloudinaryConnection,
  handleUploadError,
};