/**
 * Socket.io real-time layer (HS3): FR-10 chat, FR-09 live tracking, booking
 * lifecycle fan-out, and signalling-only calls (see SOCKET_API.md — in-app
 * voice is intentionally NOT implemented; audio is handed to the native
 * dialer).
 *
 * Attached to the HTTP server in src/server.js. On serverless hosts (Vercel)
 * WebSockets are unavailable — every socket event has a REST fallback, so the
 * app degrades to polling there; run locally/Heroku for the live demo.
 */
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Provider = require('../models/Provider');
const Booking = require('../modules/homeservice/models/Booking');
const { registerChatHandlers } = require('./chatHandler');
const { registerTrackingHandlers } = require('./trackingHandler');

let io = null;

function initSockets(server) {
  const { Server } = require('socket.io');
  io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 30000,
  });

  // JWT auth — same secret + lookup as src/middleware/authMiddleware.js.
  // Unauthenticated connections are rejected outright.
  io.use(async (socket, next) => {
    try {
      const token =
        (socket.handshake.auth && socket.handshake.auth.token) ||
        socket.handshake.headers.authorization?.split(' ')[1];
      if (!token) return next(new Error('Authentication required'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      let user = await User.findById(decoded.id).select('-password');
      let role = 'user';
      if (!user) {
        user = await Provider.findById(decoded.id).select('-password');
        role = 'provider';
      }
      if (!user) return next(new Error('Authentication failed'));

      socket.user = user;
      socket.userRole = role;
      next();
    } catch (e) {
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    // join_booking { bookingId } — membership verified server-side; a
    // client-supplied room name is never trusted.
    socket.on('join_booking', async (payload = {}, ack) => {
      const { bookingId } = payload;
      try {
        const booking = await Booking.findById(bookingId).select('customer provider');
        if (!booking) {
          if (ack) ack({ success: false, message: 'Booking not found' });
          return;
        }
        const uid = String(socket.user._id);
        const isMember =
          String(booking.customer) === uid || String(booking.provider) === uid;
        if (!isMember) {
          if (ack) ack({ success: false, message: 'Not a participant of this booking' });
          return;
        }
        socket.join(`booking:${bookingId}`);
        if (ack) ack({ success: true });
      } catch (e) {
        if (ack) ack({ success: false, message: 'Failed to join booking' });
      }
    });

    socket.on('leave_booking', (payload = {}) => {
      if (payload.bookingId) socket.leave(`booking:${payload.bookingId}`);
    });

    registerChatHandlers(io, socket);
    registerTrackingHandlers(io, socket);

    // Signalling-only calling (documented decision in SOCKET_API.md): the
    // events carry ring/accept/decline/end between participants; actual audio
    // uses the phone's native dialer.
    ['call_ring', 'call_accept', 'call_decline', 'call_end'].forEach((event) => {
      socket.on(event, (payload = {}) => {
        const { bookingId } = payload;
        if (!bookingId || !socket.rooms.has(`booking:${bookingId}`)) return;
        socket.to(`booking:${bookingId}`).emit(event, {
          bookingId,
          from: { id: String(socket.user._id), role: socket.userRole },
          at: new Date().toISOString(),
        });
      });
    });
  });

  return io;
}

/** Fan-out helper used by REST controllers/services. No-ops when io is not up. */
function emitToBooking(bookingId, event, payload) {
  if (!io) return;
  io.to(`booking:${bookingId}`).emit(event, payload);
}

module.exports = { initSockets, emitToBooking };
