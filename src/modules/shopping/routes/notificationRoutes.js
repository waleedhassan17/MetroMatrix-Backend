const express = require('express');
const router = express.Router();
const { protect } = require('../../../middleware/authMiddleware');
const c = require('../controllers/notificationController');

// Customers and vendors alike — scoped to whoever is signed in.
router.get('/notifications', protect, c.listNotifications);
router.get('/notifications/unread-count', protect, c.unreadCount);
router.patch('/notifications/read-all', protect, c.markAllRead);
router.patch('/notifications/:id/read', protect, c.markRead);

module.exports = router;
