/**
 * "Your provider is about 5 minutes away."
 *
 * Only the realtime service sees live positions (they are never stored —
 * NFR-08), so it DETECTS the moment and calls
 * POST /api/internal/homeservice/bookings/:id/nearby. This module OWNS the
 * alert: one atomic claim on the booking (`notifications.nearbyAt`), then the
 * in-app notice, the push and the room event. Whoever asks twice — a retry,
 * a reconnect, the REST location fallback — gets "already sent".
 */
const Booking = require('../models/Booking');
const { STATUS } = require('./statusMap');
const { estimatedTravelMinutes } = require('./matchingService');

/** Close enough to say "about 5 minutes": ≤ 5 min at city speed, or ≤ 1.5 km. */
const NEARBY_ETA_MIN = 5;
const NEARBY_DISTANCE_M = 1500;

function shouldNotifyNearby(distanceMeters, speedKmh) {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) return false;
  if (distanceMeters <= NEARBY_DISTANCE_M) return true;
  return estimatedTravelMinutes(distanceMeters, speedKmh) <= NEARBY_ETA_MIN;
}

/**
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function notifyNearbyOnce(bookingId, { distanceMeters, etaMinutes } = {}) {
  const now = new Date();
  // The claim: only an EN_ROUTE booking never alerted before.
  const claim = await Booking.updateOne(
    { _id: bookingId, status: STATUS.EN_ROUTE, 'notifications.nearbyAt': null },
    { $set: { 'notifications.nearbyAt': now } }
  );
  if (!claim.modifiedCount) return { sent: false, reason: 'already sent, or not on the way' };

  const b = await Booking.findById(bookingId).populate('customer', 'fullName').populate('provider', 'fullName');
  if (!b) return { sent: false, reason: 'booking not found' };
  const eta = Number.isFinite(etaMinutes) ? Math.max(1, Math.round(etaMinutes)) : NEARBY_ETA_MIN;
  const providerName = (b.provider && b.provider.fullName) || 'Your provider';
  const customerId = (b.customer && b.customer._id) || b.customer;

  const { pushToUser, emitToBooking } = require('../../../sockets');
  const results = await Promise.allSettled([
    require('./notificationService').notifyProviderNearby(b, { providerName, etaMinutes: eta }),
    pushToUser(customerId, 'user', {
      type: 'booking_nearby',
      title: 'Almost there',
      body: `${providerName} is about ${eta} minute${eta === 1 ? '' : 's'} away.`,
      data: { bookingId: String(b._id), roomType: 'homeservice', audience: 'customer', etaMinutes: eta },
    }),
    emitToBooking(b._id, 'provider_nearby', {
      bookingId: String(b._id),
      roomId: String(b._id),
      etaMinutes: eta,
      distanceMeters: Number.isFinite(distanceMeters) ? Math.round(distanceMeters) : null,
    }),
  ]);
  results.forEach((r) => {
    if (r.status === 'rejected') console.error(`[nearby] side effect failed booking=${bookingId}: ${r.reason && r.reason.message}`);
  });
  return { sent: true };
}

module.exports = { notifyNearbyOnce, shouldNotifyNearby, NEARBY_ETA_MIN, NEARBY_DISTANCE_M };
