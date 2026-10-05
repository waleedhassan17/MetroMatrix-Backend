const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const { notifyNearbyOnce } = require('../services/nearbyService');

/**
 * POST /api/internal/homeservice/bookings/:bookingId/nearby
 *   { distanceMeters?, etaMinutes? }   (x-internal-key)
 *
 * Called by the realtime service when a provider's live position comes within
 * about five minutes of the customer. Idempotent: 200 { sent:false } when the
 * alert already went out or the booking is no longer on the way.
 */
const providerNearby = asyncHandler(async (req, res) => {
  const { bookingId } = req.params;
  if (!mongoose.isValidObjectId(bookingId)) {
    res.status(400);
    throw new Error('Invalid booking id');
  }
  const distanceMeters = Number(req.body && req.body.distanceMeters);
  const etaMinutes = Number(req.body && req.body.etaMinutes);
  const result = await notifyNearbyOnce(bookingId, {
    distanceMeters: Number.isFinite(distanceMeters) ? distanceMeters : undefined,
    etaMinutes: Number.isFinite(etaMinutes) ? etaMinutes : undefined,
  });
  res.json({ success: true, data: result });
});

module.exports = { providerNearby };
