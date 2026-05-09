const express = require('express');
const router = express.Router();
const {
  getNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
} = require('../controllers/notificationController');
const { requireUser } = require('../middleware/healthcareAuth');

// All routes require authentication
router.use(requireUser);

// IMPORTANT: /read-all MUST come before /:notificationId to avoid
// Express matching "read-all" as a notificationId parameter
router.get('/', getNotifications);
router.patch('/read-all', markAllAsRead);
router.patch('/:notificationId/read', markAsRead);
router.delete('/:notificationId', deleteNotification);

module.exports = router;
