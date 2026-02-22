// src/services/socketService.js
const ChatRoom = require('../models/Chat');
const jwt = require('jsonwebtoken');

/**
 * Socket.IO real-time handler.
 * Handles:
 *   - Authenticated socket connections (JWT handshake)
 *   - Chat messaging (send, deliver, read receipts)
 *   - Voice call signaling (initiate, accept, reject, end)
 *   - Online presence
 *
 * @param {import('socket.io').Server} io
 */
function initSocketService(io) {
  // ─── In-memory presence map: userId/providerId -> socketId ───
  const onlineUsers = new Map(); // key: `${role}:${id}`, value: socketId

  // ─── JWT Authentication Middleware for Socket.IO ─────────────
  io.use((socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.split(' ')[1];

      if (!token) return next(new Error('Authentication token missing'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = decoded; // { id, role: 'user' | 'provider', name, ... }
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  // ─── Connection Handler ───────────────────────────────────────
  io.on('connection', (socket) => {
    const { id: userId, role, name } = socket.user;
    const presenceKey = `${role}:${userId}`;

    console.log(`[Socket] ${role} connected: ${name} (${userId})`);

    // Register presence
    onlineUsers.set(presenceKey, socket.id);

    // Broadcast online status to contacts
    socket.broadcast.emit('user:online', { userId, role });

    // ── Join Chat Room ─────────────────────────────────────────
    socket.on('chat:join', (roomId) => {
      socket.join(roomId);
      console.log(`[Socket] ${name} joined room ${roomId}`);
    });

    // ── Leave Chat Room ────────────────────────────────────────
    socket.on('chat:leave', (roomId) => {
      socket.leave(roomId);
    });

    // ── Send Message ───────────────────────────────────────────
    socket.on('chat:send', async (data) => {
      try {
        const { roomId, content, type = 'text', mediaUrl = null } = data;

        const senderType = role === 'provider' ? 'Provider' : 'User';

        const message = {
          senderId: userId,
          senderType,
          content,
          type,
          mediaUrl,
          status: 'sent',
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        // Persist to MongoDB
        const room = await ChatRoom.findByIdAndUpdate(
          roomId,
          {
            $push: { messages: message },
            $set: {
              lastMessage: content,
              lastMessageAt: new Date(),
              lastMessageBy: userId,
            },
            $inc: role === 'provider'
              ? { unreadCountUser: 1 }
              : { unreadCountProvider: 1 },
          },
          { new: true }
        );

        if (!room) {
          socket.emit('chat:error', { message: 'Room not found' });
          return;
        }

        // Get the saved message (last one)
        const savedMessage = room.messages[room.messages.length - 1];

        // Emit to everyone in the room (including sender)
        io.to(roomId).emit('chat:message', {
          roomId,
          message: savedMessage,
        });

        // Update unread count for the other party
        const otherPartyKey =
          role === 'provider'
            ? `user:${room.userId}`
            : `provider:${room.providerId}`;

        const otherSocketId = onlineUsers.get(otherPartyKey);
        if (otherSocketId) {
          io.to(otherSocketId).emit('chat:unread', {
            roomId,
            count: role === 'provider' ? room.unreadCountUser : room.unreadCountProvider,
          });
        }
      } catch (err) {
        console.error('[Socket] chat:send error:', err);
        socket.emit('chat:error', { message: 'Failed to send message' });
      }
    });

    // ── Typing Indicators ──────────────────────────────────────
    socket.on('chat:typing', ({ roomId }) => {
      socket.to(roomId).emit('chat:typing', { userId, role });
    });

    socket.on('chat:stopTyping', ({ roomId }) => {
      socket.to(roomId).emit('chat:stopTyping', { userId, role });
    });

    // ── Mark Messages as Read ──────────────────────────────────
    socket.on('chat:read', async ({ roomId }) => {
      try {
        const update =
          role === 'provider'
            ? { unreadCountProvider: 0 }
            : { unreadCountUser: 0 };

        const room = await ChatRoom.findByIdAndUpdate(
          roomId,
          {
            $set: {
              ...update,
              'messages.$[elem].status': 'read',
              'messages.$[elem].readAt': new Date(),
            },
          },
          {
            arrayFilters: [
              {
                'elem.senderType': role === 'provider' ? 'User' : 'Provider',
                'elem.status': { $ne: 'read' },
              },
            ],
            new: true,
          }
        );

        // Notify sender that messages were read
        const senderKey =
          role === 'provider'
            ? `user:${room.userId}`
            : `provider:${room.providerId}`;

        const senderSocketId = onlineUsers.get(senderKey);
        if (senderSocketId) {
          io.to(senderSocketId).emit('chat:read', { roomId, readBy: userId });
        }
      } catch (err) {
        console.error('[Socket] chat:read error:', err);
      }
    });

    // ═══════════════════════════════════════════════════════════
    // VOICE CALL SIGNALING
    // Call flow:
    //   1. Caller emits call:initiate -> receiver gets call:incoming
    //   2. Receiver emits call:accept -> caller gets call:accepted
    //   3. Either party emits call:end -> both get call:ended
    //   4. Receiver emits call:reject -> caller gets call:rejected
    // ═══════════════════════════════════════════════════════════

    socket.on('call:initiate', ({ receiverId, receiverRole, channelName, callerInfo, serviceType }) => {
      const receiverKey = `${receiverRole}:${receiverId}`;
      const receiverSocketId = onlineUsers.get(receiverKey);

      if (!receiverSocketId) {
        // Receiver offline – caller will handle timeout as "missed"
        socket.emit('call:missed', { receiverId, message: 'User is offline' });
        return;
      }

      io.to(receiverSocketId).emit('call:incoming', {
        callerId: userId,
        callerRole: role,
        callerInfo,        // { name, image, specialty, serviceType }
        channelName,       // Agora channel name
        serviceType,
      });

      // Notify caller that ringing
      socket.emit('call:ringing', { receiverId, channelName });
    });

    socket.on('call:accept', ({ callerId, callerRole, channelName }) => {
      const callerKey = `${callerRole}:${callerId}`;
      const callerSocketId = onlineUsers.get(callerKey);

      if (callerSocketId) {
        io.to(callerSocketId).emit('call:accepted', {
          acceptedBy: userId,
          channelName,
        });
      }
    });

    socket.on('call:reject', ({ callerId, callerRole, channelName }) => {
      const callerKey = `${callerRole}:${callerId}`;
      const callerSocketId = onlineUsers.get(callerKey);

      if (callerSocketId) {
        io.to(callerSocketId).emit('call:rejected', {
          rejectedBy: userId,
          channelName,
        });
      }
    });

    socket.on('call:end', ({ otherPartyId, otherPartyRole, channelName, durationSeconds }) => {
      const otherKey = `${otherPartyRole}:${otherPartyId}`;
      const otherSocketId = onlineUsers.get(otherKey);

      if (otherSocketId) {
        io.to(otherSocketId).emit('call:ended', {
          endedBy: userId,
          channelName,
          durationSeconds,
        });
      }
    });

    // ── Disconnect ─────────────────────────────────────────────
    socket.on('disconnect', () => {
      onlineUsers.delete(presenceKey);
      socket.broadcast.emit('user:offline', { userId, role });
      console.log(`[Socket] ${role} disconnected: ${name} (${userId})`);
    });
  });

  return io;
}

module.exports = { initSocketService };
