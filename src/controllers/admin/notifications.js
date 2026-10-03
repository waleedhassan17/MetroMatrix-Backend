const asyncHandler = require('express-async-handler');
const Notification = require('../../models/Notification');
const AppError = require('../../utils/AppError');
const { ERROR_CODES } = require('../../utils/errorCodes');
const { ok } = require('../../utils/apiResponse');
const { parseListQuery, findPage, clampInt } = require('../../utils/pagination');
const { audit } = require('../../services/auditService');

/*
 * The admin's notification feed — /api/admin/notifications*.
 *
 * Read and dismissed state is per admin, and each admin only sees what their
 * permissions cover (Notification.visibleTo). "Delete" dismisses for the
 * caller; permanently purging old notifications for everyone needs
 * canManageNotifications.
 */

// Pre-B3 documents carried the target in data.providerId / data.userId.
function targetOf(n) {
  if (n.target?.type && n.target?.id) return { type: n.target.type, id: String(n.target.id) };
  if (n.data?.providerId) return { type: 'Provider', id: String(n.data.providerId) };
  if (n.data?.userId) return { type: 'User', id: String(n.data.userId) };
  return null;
}

const present = (n, admin) => ({
  id: String(n._id),
  type: n.type,
  title: n.title,
  message: n.message,
  severity: n.severity || n.data?.severity || 'info',
  target: targetOf(n),
  read: (n.readBy || []).some((id) => String(id) === String(admin._id)),
  createdAt: n.createdAt,
});

const unreadFilter = (admin) => ({ $and: [Notification.visibleTo(admin), { readBy: { $ne: admin._id } }] });

// @route GET /api/admin/notifications?unread=true&type=&page=&limit=&cursor=
const listNotifications = asyncHandler(async (req, res) => {
  const filters = [Notification.visibleTo(req.user)];
  if (req.query.unread === 'true') filters.push({ readBy: { $ne: req.user._id } });
  if (typeof req.query.type === 'string' && Notification.TYPES.includes(req.query.type)) filters.push({ type: req.query.type });
  const list = parseListQuery(req.query, { sortable: ['createdAt'], defaultSort: '-createdAt' });
  const [{ items, meta }, unread] = await Promise.all([
    findPage(Notification, { $and: filters }, list, { lean: true }),
    Notification.countDocuments(unreadFilter(req.user)),
  ]);
  ok(res, items.map((n) => present(n, req.user)), { ...meta, unread });
});

// @route GET /api/admin/notifications/unread-count
const unreadCount = asyncHandler(async (req, res) => {
  ok(res, { unread: await Notification.countDocuments(unreadFilter(req.user)) });
});

async function visibleById(req) {
  const n = await Notification.findOne({ $and: [{ _id: req.params.notificationId }, Notification.visibleTo(req.user)] });
  if (!n) throw new AppError(ERROR_CODES.NOT_FOUND, 'Notification not found');
  return n;
}

// @route PUT /api/admin/notifications/:notificationId/read
const markRead = asyncHandler(async (req, res) => {
  const n = await visibleById(req);
  await Notification.updateOne({ _id: n._id }, { $addToSet: { readBy: req.user._id } });
  ok(res, { id: String(n._id), read: true });
});

// @route PUT /api/admin/notifications/read-all
const markAllRead = asyncHandler(async (req, res) => {
  const { modifiedCount } = await Notification.updateMany(unreadFilter(req.user), { $addToSet: { readBy: req.user._id } });
  ok(res, { marked: modifiedCount });
});

// @route DELETE /api/admin/notifications/:notificationId — dismiss for me
const dismiss = asyncHandler(async (req, res) => {
  const n = await visibleById(req);
  await Notification.updateOne({ _id: n._id }, { $addToSet: { dismissedBy: req.user._id, readBy: req.user._id } });
  ok(res, { id: String(n._id), dismissed: true });
});

// @route DELETE /api/admin/notifications/clear-all — dismiss everything I've read
const dismissAllRead = asyncHandler(async (req, res) => {
  const { modifiedCount } = await Notification.updateMany(
    { $and: [Notification.visibleTo(req.user), { readBy: req.user._id }] },
    { $addToSet: { dismissedBy: req.user._id } }
  );
  ok(res, { dismissed: modifiedCount });
});

// @route DELETE /api/admin/notifications/purge?olderThanDays=90  (canManageNotifications)
// Permanently removes old notifications for every admin.
const purgeOld = asyncHandler(async (req, res) => {
  const days = clampInt(req.query.olderThanDays, 90, 30, 3650);
  const before = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const { deletedCount } = await Notification.deleteMany({ createdAt: { $lt: before } });
  await audit(req, { action: 'notification.purge', module: 'core', meta: { olderThanDays: days, deletedCount } });
  ok(res, { deleted: deletedCount, olderThanDays: days });
});

module.exports = { listNotifications, unreadCount, markRead, markAllRead, dismiss, dismissAllRead, purgeOld };
