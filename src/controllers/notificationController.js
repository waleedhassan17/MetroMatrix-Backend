const asyncHandler = require('express-async-handler');
const Notification = require('../models/Notification');

// @desc    Get notifications
// @route   GET /api/admin/notifications
// @access  Private/Admin
const getNotifications = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    type = '',
    isRead = '',
  } = req.query;
  
  const query = {};
  
  // Admin-specific or broadcast notifications
  query.$or = [
    { adminId: req.user._id },
    { adminId: null }, // Broadcast notifications
  ];
  
  // Type filter
  if (type) {
    query.type = type;
  }
  
  // Read status filter
  if (isRead !== '') {
    query.isRead = isRead === 'true';
  }
  
  const skip = (parseInt(page) - 1) * parseInt(limit);
  
  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate('data.providerId', 'fullName email providerType')
      .populate('data.userId', 'fullName email'),
    Notification.countDocuments(query),
    Notification.getUnreadCount(req.user._id),
  ]);
  
  const pages = Math.ceil(total / parseInt(limit));
  const currentPage = parseInt(page);
  
  res.json({
    success: true,
    notifications: notifications.map(n => ({
      id: n._id,
      _id: n._id,
      type: n.type,
      title: n.title,
      message: n.message,
      data: n.data,
      isRead: n.isRead,
      createdAt: n.createdAt,
      readAt: n.readAt,
    })),
    pagination: {
      page: currentPage,
      limit: parseInt(limit),
      total,
      pages,
      hasNext: currentPage < pages,
      hasPrev: currentPage > 1,
    },
    unreadCount,
  });
});

// @desc    Get unread notification count
// @route   GET /api/admin/notifications/unread-count
// @access  Private/Admin
const getUnreadCount = asyncHandler(async (req, res) => {
  const count = await Notification.getUnreadCount(req.user._id);
  
  res.json({
    success: true,
    unreadCount: count,
  });
});

// @desc    Mark notification as read
// @route   PUT /api/admin/notifications/:notificationId/read
// @access  Private/Admin
const markAsRead = asyncHandler(async (req, res) => {
  const notification = await Notification.findById(req.params.notificationId);
  
  if (!notification) {
    res.status(404);
    throw new Error('Notification not found');
  }
  
  // Check if notification belongs to this admin or is broadcast
  if (notification.adminId && notification.adminId.toString() !== req.user._id.toString()) {
    res.status(403);
    throw new Error('Not authorized to access this notification');
  }
  
  notification.isRead = true;
  notification.readAt = new Date();
  await notification.save();
  
  res.json({
    success: true,
    message: 'Notification marked as read',
    data: {
      id: notification._id,
      isRead: true,
      readAt: notification.readAt,
    },
  });
});

// @desc    Mark all notifications as read
// @route   PUT /api/admin/notifications/read-all
// @access  Private/Admin
const markAllAsRead = asyncHandler(async (req, res) => {
  const updatedCount = await Notification.markAllAsRead(req.user._id);
  
  res.json({
    success: true,
    message: 'All notifications marked as read',
    data: {
      updatedCount,
    },
  });
});

// @desc    Delete notification
// @route   DELETE /api/admin/notifications/:notificationId
// @access  Private/Admin
const deleteNotification = asyncHandler(async (req, res) => {
  const notification = await Notification.findById(req.params.notificationId);
  
  if (!notification) {
    res.status(404);
    throw new Error('Notification not found');
  }
  
  // Check if notification belongs to this admin or is broadcast
  if (notification.adminId && notification.adminId.toString() !== req.user._id.toString()) {
    res.status(403);
    throw new Error('Not authorized to delete this notification');
  }
  
  await Notification.deleteOne({ _id: notification._id });
  
  res.json({
    success: true,
    message: 'Notification deleted successfully',
  });
});

// @desc    Clear all notifications
// @route   DELETE /api/admin/notifications/clear-all
// @access  Private/Admin
const clearAllNotifications = asyncHandler(async (req, res) => {
  const result = await Notification.deleteMany({
    $or: [
      { adminId: req.user._id },
      { adminId: null, isRead: true }, // Only clear read broadcast notifications
    ],
  });
  
  res.json({
    success: true,
    message: 'All notifications cleared',
    data: {
      deletedCount: result.deletedCount,
    },
  });
});

module.exports = {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  clearAllNotifications,
};
