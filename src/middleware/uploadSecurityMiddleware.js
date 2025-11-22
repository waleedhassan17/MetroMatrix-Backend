const path = require('path');
const fs = require('fs').promises;

/**
 * Security middleware for serving uploaded files
 * Prevents unauthorized access and ensures file safety
 */

// Allowed file extensions by type
const ALLOWED_EXTENSIONS = {
  images: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
  documents: ['.pdf', '.doc', '.docx'],
  all: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.doc', '.docx']
};

// Maximum file sizes (in bytes)
const MAX_FILE_SIZES = {
  image: 5 * 1024 * 1024,      // 5MB
  document: 10 * 1024 * 1024,  // 10MB
};

/**
 * Check if file extension is allowed
 */
const isAllowedExtension = (filename, type = 'all') => {
  const ext = path.extname(filename).toLowerCase();
  const allowedExts = ALLOWED_EXTENSIONS[type] || ALLOWED_EXTENSIONS.all;
  return allowedExts.includes(ext);
};

/**
 * Sanitize filename to prevent directory traversal
 */
const sanitizeFilename = (filename) => {
  // Remove any directory traversal attempts
  let sanitized = filename.replace(/\.\./g, '');
  
  // Remove any non-alphanumeric characters except dots, dashes, and underscores
  sanitized = sanitized.replace(/[^a-zA-Z0-9.\-_]/g, '');
  
  return sanitized;
};

/**
 * Check if user has permission to access file
 */
const checkFilePermission = async (req, filePath) => {
  // Extract user ID from authenticated user
  const userId = req.user?.id;
  const isAdmin = req.user?.constructor?.modelName === 'Admin';
  
  // Admins can access all files
  if (isAdmin) return true;
  
  // Check if file belongs to the user
  const filePathParts = filePath.split(path.sep);
  
  // Extract entity type and ID from path
  if (filePathParts.includes('users') && filePathParts.includes(userId)) {
    return true;
  }
  
  if (filePathParts.includes('providers') && filePathParts.includes(userId)) {
    return true;
  }
  
  // Posts are public
  if (filePathParts.includes('posts')) {
    return true;
  }
  
  return false;
};

/**
 * Serve upload middleware
 * Securely serves uploaded files with permission checks
 */
const serveUpload = async (req, res, next) => {
  try {
    // Get requested file path
    const requestedPath = req.path.replace('/uploads/', '');
    const sanitizedPath = sanitizeFilename(requestedPath);
    
    // Construct full file path
    const uploadsDir = path.join(__dirname, '../uploads');
    const fullPath = path.join(uploadsDir, sanitizedPath);
    
    // Security check: ensure file is within uploads directory
    const normalizedPath = path.normalize(fullPath);
    if (!normalizedPath.startsWith(uploadsDir)) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }
    
    // Check if file exists
    try {
      await fs.access(fullPath);
    } catch (error) {
      return res.status(404).json({
        success: false,
        error: 'File not found'
      });
    }
    
    // Check file extension
    if (!isAllowedExtension(sanitizedPath)) {
      return res.status(403).json({
        success: false,
        error: 'File type not allowed'
      });
    }
    
    // Check permission (skip for public files)
    const isPublicPath = requestedPath.includes('posts/images');
    if (!isPublicPath) {
      const hasPermission = await checkFilePermission(req, requestedPath);
      if (!hasPermission && req.user) {
        return res.status(403).json({
          success: false,
          error: 'You do not have permission to access this file'
        });
      }
    }
    
    // Get file stats
    const stats = await fs.stat(fullPath);
    
    // Check file size
    const ext = path.extname(fullPath).toLowerCase();
    const isImage = ALLOWED_EXTENSIONS.images.includes(ext);
    const maxSize = isImage ? MAX_FILE_SIZES.image : MAX_FILE_SIZES.document;
    
    if (stats.size > maxSize) {
      return res.status(413).json({
        success: false,
        error: 'File too large'
      });
    }
    
    // Set proper content type
    const contentTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    };
    
    const contentType = contentTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    
    // Set cache headers for images
    if (isImage) {
      res.setHeader('Cache-Control', 'public, max-age=2592000'); // 30 days
    }
    
    // Serve the file
    res.sendFile(fullPath);
    
  } catch (error) {
    console.error('Error serving upload:', error);
    res.status(500).json({
      success: false,
      error: 'Error serving file'
    });
  }
};

/**
 * Clean up temporary files
 * Should be run periodically (e.g., daily cron job)
 */
const cleanupTempFiles = async () => {
  try {
    const tempDir = path.join(__dirname, '../uploads/temp');
    const files = await fs.readdir(tempDir);
    
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    
    let deletedCount = 0;
    
    for (const file of files) {
      if (file === '.gitkeep') continue;
      
      const filePath = path.join(tempDir, file);
      const stats = await fs.stat(filePath);
      
      // Delete files older than 24 hours
      if (now - stats.mtimeMs > maxAge) {
        await fs.unlink(filePath);
        deletedCount++;
        console.log(`Deleted temp file: ${file}`);
      }
    }
    
    console.log(`Cleanup complete. Deleted ${deletedCount} temporary files.`);
    return deletedCount;
    
  } catch (error) {
    console.error('Error cleaning up temp files:', error);
    throw error;
  }
};

/**
 * Get file metadata
 */
const getFileMetadata = async (filePath) => {
  try {
    const stats = await fs.stat(filePath);
    const ext = path.extname(filePath).toLowerCase();
    
    return {
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime,
      extension: ext,
      mimeType: (() => {
        const types = {
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.png': 'image/png',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.pdf': 'application/pdf'
        };
        return types[ext] || 'application/octet-stream';
      })()
    };
  } catch (error) {
    throw new Error('File not found');
  }
};

/**
 * Delete file safely
 */
const deleteFileSafely = async (filePath) => {
  try {
    // Security check
    const uploadsDir = path.join(__dirname, '../uploads');
    const normalizedPath = path.normalize(filePath);
    
    if (!normalizedPath.startsWith(uploadsDir)) {
      throw new Error('Invalid file path');
    }
    
    // Don't delete .gitkeep files
    if (path.basename(filePath) === '.gitkeep') {
      throw new Error('Cannot delete .gitkeep files');
    }
    
    await fs.unlink(filePath);
    console.log(`File deleted: ${filePath}`);
    return true;
    
  } catch (error) {
    console.error('Error deleting file:', error);
    throw error;
  }
};

module.exports = {
  serveUpload,
  cleanupTempFiles,
  getFileMetadata,
  deleteFileSafely,
  isAllowedExtension,
  sanitizeFilename,
  checkFilePermission,
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZES
};