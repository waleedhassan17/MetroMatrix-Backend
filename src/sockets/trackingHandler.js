const Booking = require('../modules/homeservice/models/Booking');
const { STATUS } = require('../modules/homeservice/services/statusMap');
const { setLastLocation, clearLocation } = require('./lastLocationStore');

// Server-side throttle: at most one accepted update per booking per 3 s.
const THROTTLE_MS = 3000;
const lastAccepted = new Map();

/**
 * FR-09 live GPS tracking.
 *
 * NFR-08: provider location is broadcast to the booking room and cached
 * in memory only — it is never written to the database, and the cache entry
 * is cleared the moment the job leaves EN_ROUTE/ARRIVED. Nothing to delete
 * after job completion because nothing was ever stored.
 */
function registerTrackingHandlers(io, socket) {
  // provider_location { bookingId, lat, lng, heading? } — provider only,
  // and ONLY while the booking is EN_ROUTE or ARRIVED.
  socket.on('provider_location', async (payload = {}, ack) => {
    try {
      const { bookingId, lat, lng, heading } = payload;
      if (socket.userRole !== 'provider') {
        if (ack) ack({ success: false, message: 'Providers only' });
        return;
      }
      if (!bookingId || typeof lat !== 'number' || typeof lng !== 'number') {
        if (ack) ack({ success: false, message: 'bookingId, lat, lng required' });
        return;
      }
      if (!socket.rooms.has(`booking:${bookingId}`)) {
        if (ack) ack({ success: false, message: 'Join the booking room first' });
        return;
      }

      const now = Date.now();
      const last = lastAccepted.get(bookingId) || 0;
      if (now - last < THROTTLE_MS) {
        if (ack) ack({ success: true, throttled: true });
        return;
      }

      const booking = await Booking.findById(bookingId).select('provider status');
      if (!booking || String(booking.provider) !== String(socket.user._id)) {
        if (ack) ack({ success: false, message: 'Not your booking' });
        return;
      }
      if (![STATUS.EN_ROUTE, STATUS.ARRIVED].includes(booking.status)) {
        clearLocation(bookingId); // NFR-08: drop the cached position on any other status
        if (ack) ack({ success: false, message: `Tracking not active in status ${booking.status}` });
        return;
      }

      lastAccepted.set(bookingId, now);
      setLastLocation(bookingId, { lat, lng, heading });
      io.to(`booking:${bookingId}`).emit('provider_location_update', {
        bookingId,
        latitude: lat,
        longitude: lng,
        heading: typeof heading === 'number' ? heading : null,
        timestamp: new Date().toISOString(),
      });
      if (ack) ack({ success: true });
    } catch (e) {
      if (ack) ack({ success: false, message: 'Location update failed' });
    }
  });
}

module.exports = { registerTrackingHandlers, THROTTLE_MS };
