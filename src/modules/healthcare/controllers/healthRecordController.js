const HealthRecord = require('../models/HealthRecord');
const { cloudinary, deleteFile } = require('../../../config/cloudinary');

/**
 * Extract Cloudinary publicId from a secure URL.
 * URL format: https://res.cloudinary.com/<cloud>/image/upload/v1234567890/folder/file.ext
 *          or: https://res.cloudinary.com/<cloud>/raw/upload/v1234567890/folder/file.ext
 */
const extractPublicId = (url) => {
  try {
    const parts = url.split('/upload/');
    if (parts.length < 2) return null;
    // Remove version prefix (v1234567890/)
    const afterUpload = parts[1].replace(/^v\d+\//, '');
    // Remove file extension
    return afterUpload.replace(/\.[^.]+$/, '');
  } catch (err) {
    console.error('Failed to extract publicId from URL:', url, err.message);
    return null;
  }
};

/**
 * Determine Cloudinary resource_type from URL for proper deletion.
 */
const getResourceType = (url) => {
  if (url.includes('/raw/upload/')) return 'raw';
  if (url.includes('/video/upload/')) return 'video';
  return 'image';
};

// ═══════════════════════════════════════════════════════
//  API 1: GET /health-records  [requireUser]
// ═══════════════════════════════════════════════════════

// @desc    Get user's health records
// @route   GET /api/v1/healthcare/health-records
// @access  Private
const getMyRecords = async (req, res, next) => {
  try {
    const { category, page = 1, limit = 10 } = req.query;
    const query = { userId: req.user._id };

    if (category) {
      const validCategories = ['prescriptions', 'lab_reports', 'imaging', 'vaccination'];
      if (!validCategories.includes(category)) {
        return res.status(400).json({
          success: false,
          error: `category must be one of: ${validCategories.join(', ')}`,
        });
      }
      query.category = category;
    }

    const [records, total] = await Promise.all([
      HealthRecord.find(query)
        .sort({ date: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .lean(),
      HealthRecord.countDocuments(query),
    ]);

    res.json({
      success: true,
      count: records.length,
      data: records.map((r) => ({ ...r, id: r._id })),
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    next(error);
  }
};

// ═══════════════════════════════════════════════════════
//  API 2: POST /health-records  [requireUser + upload]
// ═══════════════════════════════════════════════════════

// @desc    Create a health record with file uploads
// @route   POST /api/v1/healthcare/health-records
// @access  Private
const createRecord = async (req, res, next) => {
  try {
    const { title, category, date, notes } = req.body;

    // Validate required fields
    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, error: 'Title is required' });
    }

    const validCategories = ['prescriptions', 'lab_reports', 'imaging', 'vaccination'];
    if (!category || !validCategories.includes(category)) {
      return res.status(400).json({
        success: false,
        error: `category is required and must be one of: ${validCategories.join(', ')}`,
      });
    }

    // Validate at least one file
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one file is required',
      });
    }

    // Extract Cloudinary URLs from uploaded files
    const fileUrls = req.files.map((f) => f.path || f.secure_url || f.url);

    const record = await HealthRecord.create({
      userId: req.user._id,
      title: title.trim(),
      category,
      date: date ? new Date(date) : new Date(),
      notes: notes || '',
      files: fileUrls,
    });

    res.status(201).json({
      success: true,
      message: 'Health record created successfully',
      data: record,
    });
  } catch (error) {
    // If record creation fails, try to clean up uploaded files
    if (req.files && req.files.length > 0) {
      try {
        const cleanupPromises = req.files.map((f) => {
          const url = f.path || f.secure_url || f.url;
          const publicId = extractPublicId(url);
          if (publicId) {
            return cloudinary.uploader.destroy(publicId, {
              resource_type: getResourceType(url),
            });
          }
          return Promise.resolve();
        });
        await Promise.allSettled(cleanupPromises);
      } catch (cleanupErr) {
        console.error('Failed to clean up uploaded files:', cleanupErr.message);
      }
    }
    next(error);
  }
};

// ═══════════════════════════════════════════════════════
//  API 3: DELETE /health-records/:recordId  [requireUser]
// ═══════════════════════════════════════════════════════

// @desc    Delete a health record and its Cloudinary files
// @route   DELETE /api/v1/healthcare/health-records/:recordId
// @access  Private
const deleteRecord = async (req, res, next) => {
  try {
    const record = await HealthRecord.findById(req.params.recordId);

    if (!record) {
      return res.status(404).json({ success: false, error: 'Health record not found' });
    }

    // Verify ownership
    if (record.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Access denied. This record does not belong to you.',
      });
    }

    // Delete each file from Cloudinary
    if (record.files && record.files.length > 0) {
      const deletePromises = record.files.map((url) => {
        const publicId = extractPublicId(url);
        if (publicId) {
          const resourceType = getResourceType(url);
          return cloudinary.uploader
            .destroy(publicId, { resource_type: resourceType })
            .then((result) => {
              console.log(`Cloudinary delete [${resourceType}]: ${publicId}`, result.result);
              return result;
            })
            .catch((err) => {
              console.error(`Failed to delete ${publicId}:`, err.message);
              return { result: 'error', publicId };
            });
        }
        return Promise.resolve({ result: 'skipped' });
      });

      await Promise.allSettled(deletePromises);
    }

    // Delete record from MongoDB
    await HealthRecord.findByIdAndDelete(record._id);

    res.json({
      success: true,
      message: 'Health record deleted successfully',
    });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({ success: false, error: 'Invalid record ID' });
    }
    next(error);
  }
};

// ═══════════════════════════════════════════════════════
//  UPDATE (existing)
// ═══════════════════════════════════════════════════════

// @desc    Update health record metadata (no file changes)
// @route   PUT /api/v1/healthcare/health-records/:id
// @access  Private
const updateRecord = async (req, res, next) => {
  try {
    const { title, category, date, notes } = req.body;
    const updates = {};

    if (title !== undefined) updates.title = title.trim();
    if (category !== undefined) {
      const validCategories = ['prescriptions', 'lab_reports', 'imaging', 'vaccination'];
      if (!validCategories.includes(category)) {
        return res.status(400).json({
          success: false,
          error: `category must be one of: ${validCategories.join(', ')}`,
        });
      }
      updates.category = category;
    }
    if (date !== undefined) updates.date = new Date(date);
    if (notes !== undefined) updates.notes = notes;

    const record = await HealthRecord.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      updates,
      { new: true, runValidators: true }
    );

    if (!record) {
      return res.status(404).json({ success: false, error: 'Record not found' });
    }

    res.json({ success: true, data: record });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getMyRecords,
  createRecord,
  deleteRecord,
  updateRecord,
  extractPublicId,
};
