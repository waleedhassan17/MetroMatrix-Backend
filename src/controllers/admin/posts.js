const asyncHandler = require('express-async-handler');
const Post = require('../../models/Post');
const AppError = require('../../utils/AppError');
const { ERROR_CODES } = require('../../utils/errorCodes');
const { ok } = require('../../utils/apiResponse');
const { audit } = require('../../services/auditService');

// @route DELETE /api/admin/posts/:id   { reason }   (canManagePosts)
const deletePost = asyncHandler(async (req, res) => {
  const reason = String(req.body?.reason || req.query?.reason || '').trim();
  if (!reason) throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'A reason is required to remove a post');
  const post = await Post.findById(req.params.id);
  if (!post) throw new AppError(ERROR_CODES.NOT_FOUND, 'Post not found');
  await post.deleteOne();
  await audit(req, {
    action: 'post.delete',
    targetType: 'Post',
    targetId: post._id,
    before: { author: post.author || post.user || null, content: String(post.content || '').slice(0, 200) },
    reason,
  });
  ok(res, { id: String(post._id), deleted: true });
});

module.exports = { deletePost };
