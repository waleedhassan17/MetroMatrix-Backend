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

// Add error handling to upload functions
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

// Create storage engines for different file types
const createStorage = (folder, resourceType = 'auto') => {
  return new CloudinaryStorage({
    cloudinary: cloudinary,
    params: async (req, file) => {
      // Determine format based on file type
      let allowedFormats = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
      let transformation = [];

      if (folder === 'avatars') {
        transformation = [{ width: 500, height: 500, crop: 'limit', quality: 'auto' }];
      } else if (folder === 'documents') {
        allowedFormats = ['pdf', 'jpg', 'jpeg', 'png'];
      } else if (folder === 'posts') {
        transformation = [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto' }];
      }

      return {
        folder: `metromatrix/${folder}`,
        allowed_formats: allowedFormats,
        resource_type: resourceType,
        transformation: transformation.length > 0 ? transformation : undefined,
        public_id: `${Date.now()}-${Math.round(Math.random() * 1e9)}`,
      };
    },
  });
};

// Storage for profile photos/avatars
const avatarStorage = createStorage('avatars', 'image');

// Storage for documents (PDFs, images)
const documentStorage = createStorage('documents', 'auto');

// Storage for post images
const postImageStorage = createStorage('posts', 'image');

// File filter function
const fileFilter = (allowedTypes) => {
  return (req, file, cb) => {
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Allowed types: ${allowedTypes.join(', ')}`), false);
    }
  };
};

// Create multer upload instances
const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { 
    fileSize: 5 * 1024 * 1024, // 5MB
    files: 1
  },
  fileFilter: fileFilter(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']),
});

const uploadDocument = multer({
  storage: documentStorage,
  limits: { 
    fileSize: 10 * 1024 * 1024, // 10MB per file
    files: 15 // ✅ Allow up to 15 documents (for provider submissions with multiple fields + additionalCertificates)
  },
  fileFilter: fileFilter([
    'application/pdf',
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif'
  ]),
});

const uploadPostImage = multer({
  storage: postImageStorage,
  limits: { 
    fileSize: 5 * 1024 * 1024, // 5MB per file
    files: 5 // Maximum 5 images
  },
  fileFilter: fileFilter(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']),
});

// Delete file from Cloudinary
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

// Delete multiple files from Cloudinary
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

// Upload base64 image (useful for some cases)
const uploadBase64Image = async (base64String, folder = 'misc') => {
  try {
    const result = await cloudinary.uploader.upload(base64String, {
      folder: `metromatrix/${folder}`,
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

module.exports = {
  cloudinary,
  uploadAvatar,
  uploadDocument,
  uploadPostImage,
  deleteFile,
  deleteFiles,
  uploadBase64Image,
  testCloudinaryConnection,
  handleUploadError,
};