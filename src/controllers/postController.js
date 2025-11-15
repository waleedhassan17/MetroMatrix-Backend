const asyncHandler = require('express-async-handler');
const Post = require('../models/Post');
const Comment = require('../models/Comment');
const { deleteFile } = require('../config/cloudinary');

// @desc    Get all posts
// @route   GET /api/posts
// @access  Public
const getPosts = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  const query = { isPublished: true };

  // Filter by category
  if (req.query.category) {
    query.category = req.query.category;
  }

  // Filter by author type
  if (req.query.authorType) {
    query.authorType = req.query.authorType;
  }

  // Search
  if (req.query.search) {
    query.content = { $regex: req.query.search, $options: 'i' };
  }

  const total = await Post.countDocuments(query);
  const posts = await Post.find(query)
    .populate('author', 'fullName profilePhoto')
    .populate({
      path: 'comments',
      populate: {
        path: 'author',
        select: 'fullName profilePhoto',
      },
    })
    .sort('-createdAt')
    .limit(limit)
    .skip(skip);

  // Add isLiked field if user is authenticated
  const postsWithLikeStatus = posts.map((post) => {
    const postObj = post.toObject();
    if (req.user) {
      postObj.isLiked = post.hasUserLiked(
        req.user.id,
        req.isProvider ? 'Provider' : 'User'
      );
    }
    return postObj;
  });

  res.json({
    success: true,
    posts: postsWithLikeStatus,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Create a post
// @route   POST /api/posts
// @access  Private
const createPost = asyncHandler(async (req, res) => {
  const { content, category, tags } = req.body;

  if (!content) {
    res.status(400);
    throw new Error('Post content is required');
  }

  const postData = {
    author: req.user.id,
    authorType: req.isProvider ? 'Provider' : 'User',
    content,
    category: category || 'general',
    tags: tags || [],
  };

  // Handle images if uploaded
  if (req.files && req.files.length > 0) {
    postData.images = req.files.map((file) => ({
      url: file.path,
      publicId: file.filename,
    }));
  }

  const post = await Post.create(postData);

  // Populate author info
  await post.populate('author', 'fullName profilePhoto');

  res.status(201).json({
    success: true,
    message: 'Post created successfully',
    post,
  });
});

// @desc    Get single post
// @route   GET /api/posts/:id
// @access  Public
const getPost = asyncHandler(async (req, res) => {
  const post = await Post.findById(req.params.id)
    .populate('author', 'fullName profilePhoto')
    .populate({
      path: 'comments',
      populate: {
        path: 'author',
        select: 'fullName profilePhoto',
      },
      options: { sort: '-createdAt' },
    });

  if (!post) {
    res.status(404);
    throw new Error('Post not found');
  }

  // Increment view count
  post.viewCount += 1;
  await post.save();

  const postObj = post.toObject();
  if (req.user) {
    postObj.isLiked = post.hasUserLiked(
      req.user.id,
      req.isProvider ? 'Provider' : 'User'
    );
  }

  res.json({
    success: true,
    post: postObj,
  });
});

// @desc    Update post
// @route   PUT /api/posts/:id
// @access  Private
const updatePost = asyncHandler(async (req, res) => {
  const { content, category, tags } = req.body;
  const post = await Post.findById(req.params.id);

  if (!post) {
    res.status(404);
    throw new Error('Post not found');
  }

  // Check if user is the author
  if (post.author.toString() !== req.user.id.toString()) {
    res.status(403);
    throw new Error('You are not authorized to update this post');
  }

  // Update fields
  if (content) post.content = content;
  if (category) post.category = category;
  if (tags) post.tags = tags;

  const updatedPost = await post.save();
  await updatedPost.populate('author', 'fullName profilePhoto');

  res.json({
    success: true,
    message: 'Post updated successfully',
    post: updatedPost,
  });
});

// @desc    Delete post
// @route   DELETE /api/posts/:id
// @access  Private
const deletePost = asyncHandler(async (req, res) => {
  const post = await Post.findById(req.params.id);

  if (!post) {
    res.status(404);
    throw new Error('Post not found');
  }

  // Check if user is the author
  if (post.author.toString() !== req.user.id.toString()) {
    res.status(403);
    throw new Error('You are not authorized to delete this post');
  }

  // Delete images from Cloudinary
  if (post.images && post.images.length > 0) {
    for (const image of post.images) {
      try {
        await deleteFile(image.publicId);
      } catch (error) {
        console.error('Error deleting image:', error);
      }
    }
  }

  // Delete all comments associated with the post
  await Comment.deleteMany({ post: post._id });

  // Delete the post
  await post.deleteOne();

  res.json({
    success: true,
    message: 'Post deleted successfully',
  });
});

// @desc    Like/unlike a post
// @route   POST /api/posts/:id/like
// @access  Private
const toggleLikePost = asyncHandler(async (req, res) => {
  const post = await Post.findById(req.params.id);

  if (!post) {
    res.status(404);
    throw new Error('Post not found');
  }

  const userId = req.user.id;
  const userType = req.isProvider ? 'Provider' : 'User';

  const hasLiked = post.hasUserLiked(userId, userType);

  if (hasLiked) {
    post.removeLike(userId, userType);
  } else {
    post.addLike(userId, userType);
  }

  await post.save();

  res.json({
    success: true,
    message: hasLiked ? 'Post unliked' : 'Post liked',
    liked: !hasLiked,
    likeCount: post.likes.length,
  });
});

// @desc    Add comment to post
// @route   POST /api/posts/:id/comment
// @access  Private
const addComment = asyncHandler(async (req, res) => {
  const { content, parentComment } = req.body;
  const post = await Post.findById(req.params.id);

  if (!post) {
    res.status(404);
    throw new Error('Post not found');
  }

  if (!content) {
    res.status(400);
    throw new Error('Comment content is required');
  }

  const comment = await Comment.create({
    post: post._id,
    author: req.user.id,
    authorType: req.isProvider ? 'Provider' : 'User',
    content,
    parentComment,
  });

  // Add comment to post
  post.comments.push(comment._id);
  await post.save();

  // If it's a reply, add to parent comment's replies
  if (parentComment) {
    const parent = await Comment.findById(parentComment);
    if (parent) {
      parent.replies.push(comment._id);
      await parent.save();
    }
  }

  // Populate author info
  await comment.populate('author', 'fullName profilePhoto');

  res.status(201).json({
    success: true,
    message: 'Comment added successfully',
    comment,
  });
});

// @desc    Delete comment
// @route   DELETE /api/posts/comments/:id
// @access  Private
const deleteComment = asyncHandler(async (req, res) => {
  const comment = await Comment.findById(req.params.id);

  if (!comment) {
    res.status(404);
    throw new Error('Comment not found');
  }

  // Check if user is the author
  if (comment.author.toString() !== req.user.id.toString()) {
    res.status(403);
    throw new Error('You are not authorized to delete this comment');
  }

  // Soft delete to preserve thread structure
  comment.softDelete();
  await comment.save();

  res.json({
    success: true,
    message: 'Comment deleted successfully',
  });
});

// @desc    Report a post
// @route   POST /api/posts/:id/report
// @access  Private
const reportPost = asyncHandler(async (req, res) => {
  const { reason, description } = req.body;
  const post = await Post.findById(req.params.id);

  if (!post) {
    res.status(404);
    throw new Error('Post not found');
  }

  if (!reason) {
    res.status(400);
    throw new Error('Report reason is required');
  }

  const success = post.addReport(
    req.user.id,
    req.isProvider ? 'Provider' : 'User',
    reason,
    description
  );

  if (!success) {
    res.status(400);
    throw new Error('You have already reported this post');
  }

  await post.save();

  res.json({
    success: true,
    message: 'Post reported successfully',
  });
});

// @desc    Get user's posts
// @route   GET /api/posts/my-posts
// @access  Private
const getMyPosts = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  const query = {
    author: req.user.id,
    authorType: req.isProvider ? 'Provider' : 'User',
  };

  const total = await Post.countDocuments(query);
  const posts = await Post.find(query)
    .populate('author', 'fullName profilePhoto')
    .sort('-createdAt')
    .limit(limit)
    .skip(skip);

  res.json({
    success: true,
    posts,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

module.exports = {
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
};