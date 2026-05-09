const HCNotification = require('../models/HCNotification');

// ═══════════════════════════════════════════════════════
//  API 1: GET /notifications  [requireUser]
// ═══════════════════════════════════════════════════════

// @desc    Get user's healthcare notifications + unread count
// @route   GET /api/v1/healthcare/notifications
// @access  Private
const getNotifications = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (page - 1) * Number(limit);
    const userId = req.user._id;

    // Run list + total + unreadCount in parallel
    const [notifications, total, unreadCount] = await Promise.all([
      HCNotification.find({ userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      HCNotification.countDocuments({ userId }),
      HCNotification.countDocuments({ userId, isRead: false }),
    ]);

    res.json({
      success: true,
      data: {
        notifications: notifications.map((n) => ({ ...n, id: n._id })),
        unreadCount,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit)),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

// ═══════════════════════════════════════════════════════
//  API 2: PATCH /notifications/:notificationId/read
// ═══════════════════════════════════════════════════════

// @desc    Mark a single notification as read
// @route   PATCH /api/v1/healthcare/notifications/:notificationId/read
// @access  Private
const markAsRead = async (req, res, next) => {
  try {
    const notification = await HCNotification.findById(req.params.notificationId);

    if (!notification) {
      return res.status(404).json({ success: false, error: 'Notification not found' });
    }

    if (notification.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    notification.isRead = true;
    await notification.save();

    res.json({
      success: true,
      data: {
        notificationId: notification._id,
        isRead: true,
      },
    });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({ success: false, error: 'Invalid notification ID' });
    }
    next(error);
  }
};

// ═══════════════════════════════════════════════════════
//  API 3: PATCH /notifications/read-all  [requireUser]
// ═══════════════════════════════════════════════════════

// @desc    Mark all notifications as read
// @route   PATCH /api/v1/healthcare/notifications/read-all
// @access  Private
const markAllAsRead = async (req, res, next) => {
  try {
    const result = await HCNotification.updateMany(
      { userId: req.user._id, isRead: false },
      { isRead: true }
    );

    res.json({
      success: true,
      data: {
        updatedCount: result.modifiedCount,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete a notification
// @route   DELETE /api/v1/healthcare/notifications/:notificationId
// @access  Private
const deleteNotification = async (req, res, next) => {
  try {
    const notification = await HCNotification.findById(req.params.notificationId);

    if (!notification) {
      return res.status(404).json({ success: false, error: 'Notification not found' });
    }

    if (notification.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    await HCNotification.findByIdAndDelete(notification._id);

    res.json({ success: true, message: 'Notification deleted' });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({ success: false, error: 'Invalid notification ID' });
    }
    next(error);
  }
};

module.exports = {
  getNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
};
