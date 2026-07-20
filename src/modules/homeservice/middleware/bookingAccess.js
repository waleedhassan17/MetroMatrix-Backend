const asyncHandler = require('express-async-handler');
const Booking = require('../models/Booking');

/**
 * Ownership guard: a booking is readable/writable only by its customer, its
 * assigned provider, or an admin. Loads the booking (with customer+provider
 * populated) onto req.booking. Param name may be :id, :bookingId or :jobId.
 */
const loadBookingWithAccess = asyncHandler(async (req, res, next) => {
  const bookingId = req.params.id || req.params.bookingId || req.params.jobId;
  const booking = await Booking.findById(bookingId)
    .populate('customer', 'fullName email phoneNumber profilePhoto')
    .populate('provider', 'fullName email phoneNumber profilePhoto profession specialty ratings experience adminVerified verificationStatus isOnline basePrice providerSubType currentLocation completedBookings totalBookings city serviceAreas briefDescription');

  if (!booking) {
    res.status(404);
    throw new Error('Booking not found');
  }

  const userId = String(req.user._id);
  const isCustomer = String(booking.customer._id) === userId;
  const isProvider = String(booking.provider._id) === userId;

  if (!isCustomer && !isProvider && !req.isAdmin) {
    res.status(403);
    throw new Error('Not authorized to access this booking');
  }

  req.booking = booking;
  req.bookingRole = req.isAdmin ? 'admin' : isProvider ? 'provider' : 'customer';
  next();
});

module.exports = { loadBookingWithAccess };
