// src/controllers/chatController.js
const ChatRoom = require('../models/Chat');
const CallLog = require('../models/CallLog');
const { RtcTokenBuilder, RtcRole } = require('agora-token');

const AGORA_APP_ID = process.env.AGORA_APP_ID;
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

// ─────────────────────────────────────────────────
// CHAT ROOMS
// ─────────────────────────────────────────────────

/**
 * GET /api/chat/rooms
 * Returns all chat rooms for the authenticated user or provider.
 */
exports.getChatRooms = async (req, res) => {
  try {
    const { id: userId, role } = req.user; // set by authMiddleware

    const query =
      role === 'provider'
        ? { providerId: userId, isActive: true }
        : { userId, isActive: true };

    const rooms = await ChatRoom.find(query)
      .sort({ lastMessageAt: -1 })
      .populate('userId', 'name email profileImage')
      .populate('providerId', 'name email profileImage specialty')
      .select('-messages') // Don't send all messages in list view
      .lean();

    return res.status(200).json({ success: true, rooms });
  } catch (err) {
    console.error('getChatRooms error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * GET /api/chat/rooms/:roomId/messages?page=1&limit=30
 * Paginated message history for a chat room.
 */
exports.getMessages = async (req, res) => {
  try {
    const { roomId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;

    const room = await ChatRoom.findById(roomId).lean();
    if (!room) {
      return res.status(404).json({ success: false, message: 'Chat room not found' });
    }

    // Slice messages for pagination (newest last)
    const total = room.messages.length;
    const start = Math.max(0, total - page * limit);
    const end = total - (page - 1) * limit;
    const messages = room.messages.slice(start, end).reverse();

    return res.status(200).json({
      success: true,
      messages,
      pagination: { page, limit, total, hasMore: start > 0 },
    });
  } catch (err) {
    console.error('getMessages error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * POST /api/chat/rooms
 * Find or create a chat room between user and provider.
 */
exports.findOrCreateRoom = async (req, res) => {
  try {
    const { providerId, serviceType = 'general' } = req.body;
    const userId = req.user.id;

    let room = await ChatRoom.findOne({ userId, providerId, serviceType });

    if (!room) {
      room = await ChatRoom.create({ userId, providerId, serviceType, messages: [] });
    }

    return res.status(200).json({ success: true, room });
  } catch (err) {
    console.error('findOrCreateRoom error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * PATCH /api/chat/rooms/:roomId/read
 * Mark messages as read for the current user.
 */
exports.markAsRead = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { role, id: actorId } = req.user;

    const update =
      role === 'provider'
        ? { unreadCountProvider: 0 }
        : { unreadCountUser: 0 };

    await ChatRoom.findByIdAndUpdate(roomId, { $set: update });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('markAsRead error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────
// AGORA VOICE CALLING
// ─────────────────────────────────────────────────

/**
 * POST /api/chat/call/token
 * Generates an Agora RTC token for voice calling.
 * Body: { channelName, uid, role: 'publisher' | 'audience' }
 */
exports.generateCallToken = async (req, res) => {
  try {
    if (!AGORA_APP_ID || !AGORA_APP_CERTIFICATE) {
      return res.status(500).json({
        success: false,
        message: 'Agora credentials not configured on server',
      });
    }

    const { channelName, uid = 0 } = req.body;

    if (!channelName) {
      return res.status(400).json({ success: false, message: 'channelName is required' });
    }

    const expirationTimeInSeconds = 3600; // 1 hour
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(
      AGORA_APP_ID,
      AGORA_APP_CERTIFICATE,
      channelName,
      uid,
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );

    return res.status(200).json({
      success: true,
      token,
      appId: AGORA_APP_ID,
      channelName,
      uid,
    });
  } catch (err) {
    console.error('generateCallToken error:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate token' });
  }
};

/**
 * POST /api/chat/call/log
 * Save call log after a call ends.
 */
exports.saveCallLog = async (req, res) => {
  try {
    const { receiverId, receiverType, channelName, status, durationSeconds, serviceType } = req.body;
    const { id: callerId, role } = req.user;

    const log = await CallLog.create({
      callerId,
      callerType: role === 'provider' ? 'Provider' : 'User',
      receiverId,
      receiverType,
      channelName,
      status,
      durationSeconds: durationSeconds || 0,
      serviceType,
      startedAt: status !== 'missed' && status !== 'rejected' ? new Date() : null,
      endedAt: status === 'ended' ? new Date() : null,
    });

    return res.status(201).json({ success: true, log });
  } catch (err) {
    console.error('saveCallLog error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * GET /api/chat/call/logs
 * Get call history for the authenticated user.
 */
exports.getCallLogs = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const logs = await CallLog.find({
      $or: [{ callerId: userId }, { receiverId: userId }],
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return res.status(200).json({ success: true, logs });
  } catch (err) {
    console.error('getCallLogs error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
