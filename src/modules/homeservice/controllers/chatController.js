const asyncHandler = require('express-async-handler');
const ChatMessage = require('../models/ChatMessage');
const { avatar } = require('../services/serializers');

const ok = (res, data, message) => res.json({ success: true, data, message });

function toChatMessage(m) {
  return {
    id: String(m._id),
    text: m.text,
    sender: m.senderRole,
    timestamp: m.createdAt.toISOString(),
    status: m.readAt ? 'read' : 'delivered',
  };
}

// GET /api/chat/:bookingId — ChatData (REST history so the screen loads
// before the socket connects)
const getChatData = asyncHandler(async (req, res) => {
  const b = req.booking;
  const messages = await ChatMessage.find({ booking: b._id })
    .sort({ createdAt: 1 })
    .limit(200);
  ok(res, {
    bookingId: String(b._id),
    participants: {
      user: {
        id: String(b.customer._id),
        name: b.customer.fullName,
        image: b.customer.profilePhoto || undefined,
      },
      provider: {
        id: String(b.provider._id),
        name: b.provider.fullName,
        image: avatar(b.provider.fullName, b.provider.profilePhoto),
      },
    },
    messages: messages.map(toChatMessage),
  }, 'Chat data fetched');
});

// POST /api/chat/:bookingId/messages — { message } (REST fallback for send)
const sendMessage = asyncHandler(async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) {
    res.status(400);
    throw new Error('Message text is required');
  }
  const doc = await ChatMessage.create({
    booking: req.booking._id,
    sender: req.user._id,
    senderRole: req.bookingRole === 'provider' ? 'provider' : 'user',
    text: message.trim().slice(0, 2000),
  });

  try {
    const { emitToBooking } = require('../../../sockets');
    emitToBooking(req.booking._id, 'new_message', toChatMessage(doc));
  } catch (e) { /* socket layer unavailable — REST polling still works */ }

  ok(res, toChatMessage(doc), 'Message sent');
});

module.exports = { getChatData, sendMessage, toChatMessage };
