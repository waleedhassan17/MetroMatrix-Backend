const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { uploadPostImages } = require('../middleware/uploadMiddleware');
const { protect, optionalAuth } = require('../middleware/authMiddleware');
const { validate } = require('../middleware/validate');
const {
  getPosts,
  createPost,
  getPost,
  updatePost,
  deletePost,
  toggleLikePost,
  addComment,
  deleteComment,
  reportPost,
  getMyPosts,
} = require('../controllers/postController');

// Validation rules
const createPostRules = [
  body('content')
    .notEmpty().withMessage('Post content is required')
    .isLength({ max: 500 }).withMessage('Post cannot exceed 500 characters'),
  body('category').optional().isIn(['general', 'announcement', 'question', 'recommendation', 'service']),
  body('tags').optional().isArray().withMessage('Tags must be an array'),
];

const updatePostRules = [
  body('content').optional().isLength({ max: 500 }).withMessage('Post cannot exceed 500 characters'),
  body('category').optional().isIn(['general', 'announcement', 'question', 'recommendation', 'service']),
  body('tags').optional().isArray().withMessage('Tags must be an array'),
];

const commentRules = [
  body('content')
    .notEmpty().withMessage('Comment content is required')
    .isLength({ max: 300 }).withMessage('Comment cannot exceed 300 characters'),
  body('parentComment').optional().isMongoId().withMessage('Invalid parent comment ID'),
];

const reportRules = [
  body('reason')
    .notEmpty().withMessage('Report reason is required')
    .isIn(['spam', 'inappropriate', 'harassment', 'false_info', 'other']),
  body('description').optional().isLength({ max: 500 }).withMessage('Description cannot exceed 500 characters'),
];

// ===== PUBLIC ROUTES =====
router.get('/', optionalAuth, getPosts);
router.get('/search', optionalAuth, getPosts);
router.get('/:id', optionalAuth, getPost);

// ===== AUTHENTICATED ROUTES =====
router.use(protect);

// Create post with images - FIXED
router.post('/', uploadPostImages, createPostRules, validate, createPost);

// Update post
router.put('/:id', updatePostRules, validate, updatePost);

// Delete post
router.delete('/:id', deletePost);

// Like/unlike post
router.post('/:id/like', toggleLikePost);

// Comments
router.post('/:id/comment', commentRules, validate, addComment);
router.delete('/comments/:id', deleteComment);

// Report post
router.post('/:id/report', reportRules, validate, reportPost);

// Get user's posts
router.get('/my-posts', getMyPosts);

module.exports = router;