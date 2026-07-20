const ChatMessage = require('../modules/homeservice/models/ChatMessage');

/**
 * FR-10 in-app chat. The socket must already be authenticated (sockets/index)
 * and join_booking verified membership before any of these events matter.
 */
function registerChatHandlers(io, socket) {
  // send_message { bookingId, text } → persist, then broadcast new_message
  socket.on('send_message', async (payload = {}, ack) => {
    try {
      const { bookingId, text } = payload;
      if (!bookingId || !text || !String(text).trim()) {
        if (ack) ack({ success: false, message: 'bookingId and text are required' });
        return;
      }
      if (!socket.rooms.has(`booking:${bookingId}`)) {
        if (ack) ack({ success: false, message: 'Join the booking room first' });
        return;
      }
      const doc = await ChatMessage.create({
        booking: bookingId,
        sender: socket.user._id,
        senderRole: socket.userRole === 'provider' ? 'provider' : 'user',
        text: String(text).trim().slice(0, 2000),
      });
      const message = {
        id: String(doc._id),
        text: doc.text,
        sender: doc.senderRole,
        timestamp: doc.createdAt.toISOString(),
        status: 'delivered',
      };
      io.to(`booking:${bookingId}`).emit('new_message', message);
      if (ack) ack({ success: true, data: message });
    } catch (e) {
      if (ack) ack({ success: false, message: 'Failed to send message' });
    }
  });

  // mark_read { bookingId } — marks the OTHER side's messages read
  socket.on('mark_read', async (payload = {}) => {
    const { bookingId } = payload;
    if (!bookingId || !socket.rooms.has(`booking:${bookingId}`)) return;
    const otherRole = socket.userRole === 'provider' ? 'user' : 'provider';
    await ChatMessage.updateMany(
      { booking: bookingId, senderRole: otherRole, readAt: null },
      { readAt: new Date() }
    );
    io.to(`booking:${bookingId}`).emit('messages_read', {
      bookingId,
      readerRole: socket.userRole,
    });
  });

  // typing { bookingId, isTyping }
  socket.on('typing', (payload = {}) => {
    const { bookingId, isTyping } = payload;
    if (!bookingId || !socket.rooms.has(`booking:${bookingId}`)) return;
    socket.to(`booking:${bookingId}`).emit('typing', {
      bookingId,
      role: socket.userRole,
      isTyping: !!isTyping,
    });
  });
}

module.exports = { registerChatHandlers };
