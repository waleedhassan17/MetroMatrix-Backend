// src/routes/chatRoutes.js
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware'); // your existing auth middleware
const {
  getChatRooms,
  getMessages,
  findOrCreateRoom,
  markAsRead,
  generateCallToken,
  saveCallLog,
  getCallLogs,
} = require('../controllers/chatController');

// ── Chat Rooms ─────────────────────────────────────────────
router.get('/rooms', protect, getChatRooms);
router.post('/rooms', protect, findOrCreateRoom);
router.get('/rooms/:roomId/messages', protect, getMessages);
router.patch('/rooms/:roomId/read', protect, markAsRead);

// ── Voice Calling ──────────────────────────────────────────
router.post('/call/token', protect, generateCallToken);
router.post('/call/log', protect, saveCallLog);
router.get('/call/logs', protect, getCallLogs);

module.exports = router;
