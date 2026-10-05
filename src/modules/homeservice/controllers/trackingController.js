const asyncHandler = require('express-async-handler');
const { getLastLocation } = require('../../../sockets/lastLocationStore');
const { toTrackingStatus } = require('../services/statusMap');
const { estimatedTravelMinutes } = require('../services/matchingService');
const { avatar, SUBTYPE_TO_CATEGORY } = require('../services/serializers');
const { haversineMeters, latLngOrNull } = require('../services/geo');
const { notifyNearbyOnce, shouldNotifyNearby } = require('../services/nearbyService');

const ok = (res, data, message) => res.json({ success: true, data, message });

/**
 * GET /api/bookings/:bookingId/tracking — TrackingData cold-load fallback.
 * Live positions arrive via the provider_location_update socket event; this
 * endpoint serves the LAST KNOWN in-memory position only. Location history is
 * NEVER persisted (NFR-08) — see sockets/lastLocationStore.js.
 */
const getTrackingData = asyncHandler(async (req, res) => {
  const b = req.booking;
  const p = b.provider;

  // Only real points. The provider's position is the LIVE one or nothing:
  // falling back to their stored service base would present an area they
  // work from as "where they are now" — wrong, and a privacy leak.
  const userLocation = latLngOrNull(b.address && b.address.coordinates);
  const last = getLastLocation(String(b._id));
  const providerLocation = last ? { latitude: last.lat, longitude: last.lng } : null;

  const distanceMeters =
    providerLocation && userLocation ? haversineMeters(providerLocation, userLocation) : null;
  const etaMin = distanceMeters !== null ? estimatedTravelMinutes(distanceMeters) : null;

  ok(res, {
    provider: {
      id: String(p._id),
      name: p.fullName,
      phone: p.phoneNumber || '',
      image: avatar(p.fullName, p.profilePhoto),
      service: p.profession || p.specialty || '',
      specialty: p.profession || p.specialty || '',
      rating: p.ratings ? p.ratings.average || 0 : 0,
      reviews: p.ratings ? p.ratings.count || 0 : 0,
      experience: p.experience || '1 year',
      verified: p.adminVerified === 'active',
      category: SUBTYPE_TO_CATEGORY[p.providerSubType] || 'electricians',
    },
    providerLocation,
    userLocation,
    route:
      distanceMeters !== null
        ? {
            coordinates: [providerLocation, userLocation],
            distance: `${(distanceMeters / 1000).toFixed(1)} km`,
            distanceValue: distanceMeters,
            duration: `${etaMin} mins`,
            durationValue: etaMin * 60,
          }
        : null,
    trackingStatus: {
      status: toTrackingStatus(b.status, distanceMeters === null ? Infinity : distanceMeters),
      message: trackingMessage(b.status, distanceMeters === null ? Infinity : distanceMeters),
      timestamp: new Date().toISOString(),
    },
    bookingId: String(b._id),
  }, 'Tracking data fetched');
});

function trackingMessage(status, distanceMeters) {
  switch (status) {
    case 'EN_ROUTE':
      return distanceMeters < 500 ? 'Provider is nearby' : 'Provider is on the way';
    case 'ARRIVED':
      return 'Provider has arrived';
    case 'IN_PROGRESS':
      return 'Work in progress';
    case 'COMPLETED':
      return 'Job completed';
    default:
      return 'Waiting for provider';
  }
}

/**
 * POST /api/provider/location — REST fallback for the provider map screen
 * when the socket is unavailable. Broadcasts to the booking room; does NOT
 * persist (NFR-08).
 */
const updateProviderLocation = asyncHandler(async (req, res) => {
  const { latitude, longitude, jobId } = req.body;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    res.status(400);
    throw new Error('latitude and longitude are required numbers');
  }

  let distance = '—';
  let duration = '—';
  if (jobId) {
    const Booking = require('../models/Booking');
    const b = await Booking.findById(jobId);
    if (b && String(b.provider) === String(req.user._id)) {
      if (['EN_ROUTE', 'ARRIVED'].includes(b.status)) {
        // REST fallback path: the app prefers the `provider_location` socket
        // event and only lands here when the socket is down. emitToBooking now
        // publishes to the realtime service rather than a no-op local io.
        //
        // The empty catch this replaces is why the whole feature stayed broken
        // silently — never swallow a publish failure again.
        try {
          const { setLastLocation } = require('../../../sockets/lastLocationStore');
          const { emitToBooking } = require('../../../sockets');
          setLastLocation(String(b._id), { lat: latitude, lng: longitude });
          await emitToBooking(b._id, 'provider_location_update', {
            bookingId: String(b._id),
            roomId: String(b._id),
            latitude,
            longitude,
            heading: null,
            timestamp: new Date().toISOString(),
          });
        } catch (e) {
          console.error(`[tracking] location publish failed booking=${b._id}: ${e.message}`);
        }
      }
      // No distance to an address the customer never pinned — '—' is honest.
      const dest = latLngOrNull(b.address && b.address.coordinates);
      if (dest) {
        const meters = haversineMeters({ latitude, longitude }, dest);
        distance = `${(meters / 1000).toFixed(1)} km`;
        duration = `${estimatedTravelMinutes(meters)} mins`;
        // Same "about 5 minutes away" alert the realtime service raises —
        // idempotent, so whichever path sees the position first sends it.
        if (b.status === 'EN_ROUTE' && shouldNotifyNearby(meters)) {
          await notifyNearbyOnce(b._id, { distanceMeters: meters, etaMinutes: estimatedTravelMinutes(meters) }).catch(
            (e) => console.error(`[tracking] nearby alert failed booking=${b._id}: ${e.message}`)
          );
        }
      }
    }
  }

  ok(res, { distance, duration }, 'Location updated');
});

module.exports = { getTrackingData, updateProviderLocation };
