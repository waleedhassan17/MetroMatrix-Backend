const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Create storage engines for different file types
const createStorage = (folder, allowedFormats) => {
  return new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
      folder: `metromatrix/${folder}`,
      allowed_formats: allowedFormats,
      transformation: folder === 'avatars' ? [{ width: 500, height: 500, crop: 'limit' }] : undefined,
    },
  });
};

// Storage for profile photos
const avatarStorage = createStorage('avatars', ['jpg', 'jpeg', 'png', 'gif']);

// Storage for documents (PDFs, images)
const documentStorage = createStorage('documents', ['pdf', 'jpg', 'jpeg', 'png']);

// Storage for post images
const postImageStorage = createStorage('posts', ['jpg', 'jpeg', 'png', 'gif']);

// Create multer instances
const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

const uploadDocument = multer({
  storage: documentStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const uploadPostImage = multer({
  storage: postImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// Delete file from Cloudinary
const deleteFile = async (publicId) => {
  try {
    const result = await cloudinary.uploader.destroy(publicId);
    return result;
  } catch (error) {
    console.error('Error deleting file from Cloudinary:', error);
    throw error;
  }
};

module.exports = {
  cloudinary,
  uploadAvatar,
  uploadDocument,
  uploadPostImage,
  deleteFile,
};