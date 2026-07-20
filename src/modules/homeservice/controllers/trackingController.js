const asyncHandler = require('express-async-handler');
const { getLastLocation } = require('../../../sockets/lastLocationStore');
const { toTrackingStatus } = require('../services/statusMap');
const { estimatedTravelMinutes } = require('../services/matchingService');
const { avatar, SUBTYPE_TO_CATEGORY, coords } = require('../services/serializers');

const ok = (res, data, message) => res.json({ success: true, data, message });

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

/**
 * GET /api/bookings/:bookingId/tracking — TrackingData cold-load fallback.
 * Live positions arrive via the provider_location_update socket event; this
 * endpoint serves the LAST KNOWN in-memory position only. Location history is
 * NEVER persisted (NFR-08) — see sockets/lastLocationStore.js.
 */
const getTrackingData = asyncHandler(async (req, res) => {
  const b = req.booking;
  const p = b.provider;

  const userLocation = coords(b.address && b.address.coordinates);
  const last = getLastLocation(String(b._id));
  const providerLocation = last
    ? { latitude: last.lat, longitude: last.lng }
    : coords(p.currentLocation);

  const distanceMeters = haversineMeters(providerLocation, userLocation);
  const etaMin = estimatedTravelMinutes(distanceMeters);

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
      verified: p.adminVerified === 'approved',
      category: SUBTYPE_TO_CATEGORY[p.providerSubType] || 'electricians',
    },
    providerLocation,
    userLocation,
    route: {
      coordinates: [providerLocation, userLocation],
      distance: `${(distanceMeters / 1000).toFixed(1)} km`,
      distanceValue: distanceMeters,
      duration: `${etaMin} mins`,
      durationValue: etaMin * 60,
    },
    trackingStatus: {
      status: toTrackingStatus(b.status, distanceMeters),
      message: trackingMessage(b.status, distanceMeters),
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
        try {
          const { setLastLocation } = require('../../../sockets/lastLocationStore');
          const { emitToBooking } = require('../../../sockets');
          setLastLocation(String(b._id), { lat: latitude, lng: longitude });
          emitToBooking(b._id, 'provider_location_update', {
            bookingId: String(b._id),
            latitude,
            longitude,
            timestamp: new Date().toISOString(),
          });
        } catch (e) { /* socket layer unavailable */ }
      }
      const dest = coords(b.address && b.address.coordinates);
      const meters = haversineMeters({ latitude, longitude }, dest);
      distance = `${(meters / 1000).toFixed(1)} km`;
      duration = `${estimatedTravelMinutes(meters)} mins`;
    }
  }

  ok(res, { distance, duration }, 'Location updated');
});

module.exports = { getTrackingData, updateProviderLocation };
