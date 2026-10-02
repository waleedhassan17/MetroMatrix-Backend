const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const ShoppingNotification = require('../models/ShoppingNotification');
const { ok, paginated, fail, parsePagination } = require('../utils/respond');

/** The signed-in account's side: vendors are Provider accounts, customers User. */
const scopeOf = (req) => ({ recipient: req.user._id, recipientRole: req.isProvider ? 'vendor' : 'user' });

// GET /api/shopping/notifications
const listNotifications = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = scopeOf(req);
  const [rows, total] = await Promise.all([
    ShoppingNotification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ShoppingNotification.countDocuments(filter),
  ]);
  return paginated(res, {
    data: rows.map((n) => ({
      id: String(n._id),
      type: n.type,
      title: n.title,
      message: n.message,
      data: n.data,
      isRead: n.isRead,
      createdAt: n.createdAt,
    })),
    page,
    limit,
    total,
  });
});

// GET /api/shopping/notifications/unread-count
const unreadCount = asyncHandler(async (req, res) => {
  const count = await ShoppingNotification.countDocuments({ ...scopeOf(req), isRead: false });
  return ok(res, { count });
});

// PATCH /api/shopping/notifications/read-all
const markAllRead = asyncHandler(async (req, res) => {
  const r = await ShoppingNotification.updateMany(
    { ...scopeOf(req), isRead: false },
    { $set: { isRead: true, readAt: new Date() } }
  );
  return ok(res, { updated: r.modifiedCount });
});

// PATCH /api/shopping/notifications/:id/read
const markRead = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 400, 'Invalid notification id');
  const r = await ShoppingNotification.updateOne(
    { _id: req.params.id, ...scopeOf(req) },
    { $set: { isRead: true, readAt: new Date() } }
  );
  if (!r.matchedCount) return fail(res, 404, 'Notification not found');
  return ok(res, { id: req.params.id });
});

module.exports = { listNotifications, unreadCount, markAllRead, markRead, scopeOf };
