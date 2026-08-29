const asyncHandler = require('express-async-handler');
const HSNotification = require('../models/HSNotification');

// ============================================================================
// Home-service notifications, for BOTH the customer and the provider.
//
// One set of endpoints serves both roles. `protect` resolves a token against
// User, then Provider, then Admin and sets `req.user` to whichever matched
// (src/middleware/authMiddleware.js), so `req.user._id` is the right recipient
// id either way. Scoping every query by it means a caller can only ever see
// their own rows — there is no role check to get wrong, and no way to ask for
// somebody else's notifications.
//
// NOTE `req.user._id`, not `req.user.id`: `protect` assigns a hydrated Mongoose
// document, and this project's User/Provider toJSON are toObject() without
// virtuals. Every other home-service middleware uses `_id` for the same reason.
// ============================================================================

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

// GET /api/notifications?page=1&limit=30
const listNotifications = asyncHandler(async (req, res) => {
  const recipient = req.user._id;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);

  const [notifications, total, unreadCount] = await Promise.all([
    HSNotification.find({ recipient })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    HSNotification.countDocuments({ recipient }),
    HSNotification.countDocuments({ recipient, isRead: false }),
  ]);

  res.json({
    success: true,
    data: {
      // `.lean()` skips the toJSON transform, so add `id` here — the app reads
      // `.id` and a bare `_id` would render every row keyless.
      notifications: notifications.map((n) => ({ ...n, id: String(n._id) })),
      unreadCount,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    },
  });
});

// GET /api/notifications/unread-count
// Separate from the list so a badge does not have to fetch and discard 30 rows.
const unreadCount = asyncHandler(async (req, res) => {
  const count = await HSNotification.countDocuments({
    recipient: req.user._id,
    isRead: false,
  });
  res.json({ success: true, data: { unreadCount: count } });
});

// PATCH /api/notifications/read-all
const markAllRead = asyncHandler(async (req, res) => {
  const result = await HSNotification.updateMany(
    { recipient: req.user._id, isRead: false },
    { $set: { isRead: true, readAt: new Date() } }
  );
  res.json({ success: true, data: { updatedCount: result.modifiedCount || 0 } });
});

// PATCH /api/notifications/:notificationId/read
const markRead = asyncHandler(async (req, res) => {
  // Recipient is part of the FILTER, not checked afterwards: a caller cannot
  // mark somebody else's notification read even by guessing an id.
  const updated = await HSNotification.findOneAndUpdate(
    { _id: req.params.notificationId, recipient: req.user._id },
    { $set: { isRead: true, readAt: new Date() } },
    { new: true }
  );
  if (!updated) {
    res.status(404);
    throw new Error('Notification not found');
  }
  res.json({ success: true, data: updated });
});

module.exports = { listNotifications, unreadCount, markAllRead, markRead };
