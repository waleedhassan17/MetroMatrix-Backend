const express = require('express');
const router = express.Router();
const path = require('path');
const { optionalAuth } = require('../middleware/authMiddleware');
const { serveUpload } = require('../middleware/uploadSecurityMiddleware');

/**
 * Upload Routes
 * Securely serve uploaded files with permission checks
 */

// Serve user profile photos (public or owner only)
router.get('/users/profiles/:filename', optionalAuth, serveUpload);

// Serve provider profile photos (public)
router.get('/providers/profiles/:filename', serveUpload);

// Serve provider documents (owner or admin only)
router.get('/providers/doctors/medical-licenses/:filename', optionalAuth, serveUpload);
router.get('/providers/doctors/degree-certificates/:filename', optionalAuth, serveUpload);
router.get('/providers/doctors/national-ids/:filename', optionalAuth, serveUpload);

router.get('/providers/home-services/professional-certificates/:filename', optionalAuth, serveUpload);
router.get('/providers/home-services/national-ids/:filename', optionalAuth, serveUpload);

router.get('/providers/vendors/business-licenses/:filename', optionalAuth, serveUpload);
router.get('/providers/vendors/national-ids/:filename', optionalAuth, serveUpload);

// Serve post images (public)
router.get('/posts/images/:filename', serveUpload);

// Serve temp files (authenticated only)
router.get('/temp/:filename', optionalAuth, serveUpload);

// Get file metadata (admin only)
router.get('/metadata/*', async (req, res) => {
  try {
    // Check if user is admin
    if (!req.user || req.user.constructor.modelName !== 'Admin') {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    const { getFileMetadata } = require('../middleware/uploadSecurityMiddleware');
    const filePath = path.join(__dirname, '../uploads', req.params[0]);
    
    const metadata = await getFileMetadata(filePath);
    
    res.json({
      success: true,
      metadata
    });
    
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;