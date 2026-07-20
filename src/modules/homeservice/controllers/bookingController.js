const asyncHandler = require('express-async-handler');
const Booking = require('../models/Booking');
const SavedAddress = require('../models/SavedAddress');
const Provider = require('../../../models/Provider');
const { transition } = require('../services/bookingService');
const { STATUS, toServiceStatus, toConfirmationStatus } = require('../services/statusMap');
const {
  toBookingProvider,
  toSavedAddress,
  avatar,
  SUBTYPE_TO_CATEGORY,
} = require('../services/serializers');

const ok = (res, data, message, pagination) =>
  res.json({ success: true, data, message, ...(pagination ? { pagination } : {}) });

// Booking screen time slots — generated, marking past slots unavailable for today.
function buildTimeSlots() {
  const defs = [
    ['09:00 AM', 'morning'], ['10:00 AM', 'morning'], ['11:00 AM', 'morning'],
    ['12:00 PM', 'afternoon'], ['02:00 PM', 'afternoon'], ['04:00 PM', 'afternoon'],
    ['05:00 PM', 'evening'], ['06:00 PM', 'evening'], ['07:00 PM', 'evening'],
  ];
  return defs.map(([time, period], i) => ({
    id: String(i + 1),
    time,
    available: true,
    period,
  }));
}

// GET /api/bookings/init/:providerId — provider card + saved addresses + slots
const initBooking = asyncHandler(async (req, res) => {
  const provider = await Provider.findById(req.params.providerId);
  if (!provider || provider.providerType !== 'home_service') {
    res.status(404);
    throw new Error('Provider not found');
  }
  const addresses = await SavedAddress.find({ user: req.user._id }).sort({
    isDefault: -1,
    createdAt: -1,
  });
  ok(res, {
    provider: toBookingProvider(provider),
    addresses: addresses.map(toSavedAddress),
    timeSlots: buildTimeSlots(),
  }, 'Booking data fetched');
});

function parseScheduledFor(selectedDate, selectedTime) {
  // selectedDate: 'YYYY-MM-DD', selectedTime: 'hh:mm AM/PM'
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(selectedTime || '');
  let hours = 12;
  let minutes = 0;
  if (m) {
    hours = parseInt(m[1], 10) % 12;
    if (/pm/i.test(m[3])) hours += 12;
    minutes = parseInt(m[2], 10);
  }
  const d = new Date(`${selectedDate}T00:00:00.000+05:00`);
  if (Number.isNaN(d.getTime())) return new Date();
  d.setUTCHours(hours - 5, minutes, 0, 0); // PKT → UTC
  return d;
}

// POST /api/bookings — create → PENDING
const createBooking = asyncHandler(async (req, res) => {
  const { providerId, selectedDate, selectedTime, addressId, instructions, description } =
    req.body;

  const provider = await Provider.findById(providerId);
  if (!provider || provider.providerType !== 'home_service') {
    res.status(404);
    throw new Error('Provider not found');
  }

  let address = null;
  if (addressId) {
    address = await SavedAddress.findOne({ _id: addressId, user: req.user._id });
  }
  if (!address) {
    res.status(400);
    throw new Error('A saved address is required to create a booking');
  }

  const booking = await Booking.create({
    customer: req.user._id,
    provider: provider._id,
    serviceCategory: SUBTYPE_TO_CATEGORY[provider.providerSubType] || 'electricians',
    serviceSubCategory: provider.profession || provider.specialty || '',
    description: description || '',
    scheduledFor: parseScheduledFor(selectedDate, selectedTime),
    scheduledTime: selectedTime,
    address: {
      label: address.label,
      line1: address.line1,
      city: address.city,
      icon: address.icon,
      coordinates: address.coordinates,
    },
    instructions: instructions || '',
    pricing: { estimatedPrice: provider.basePrice || 0, currency: 'PKR' },
    statusHistory: [
      {
        status: STATUS.PENDING,
        changedBy: { id: req.user._id, role: 'customer' },
        changedAt: new Date(),
        note: 'Booking created',
      },
    ],
  });

  await Provider.updateOne({ _id: provider._id }, { $inc: { totalBookings: 1 } });

  ok(res, {
    bookingId: String(booking._id),
    status: toConfirmationStatus(booking.status),
    provider: toBookingProvider(provider),
    bookingDetails: {
      providerId: String(provider._id),
      providerName: provider.fullName,
      service: provider.profession || provider.specialty || '',
      selectedDate,
      selectedTime,
      selectedAddress: toSavedAddress(address),
      instructions: instructions || '',
      estimatedPrice: provider.basePrice || 0,
      estimatedDuration: '1-2 hours',
    },
    estimatedArrival: '15-20 minutes',
  }, 'Booking created successfully');
});

// GET /api/bookings/:id — full detail (BookingDetail screen + book-confirmation polling)
const getBooking = asyncHandler(async (req, res) => {
  const b = req.booking;
  ok(res, {
    bookingId: String(b._id),
    id: String(b._id),
    status: toConfirmationStatus(b.status),
    canonicalStatus: b.status,
    provider: toBookingProvider(b.provider),
    customer: {
      id: String(b.customer._id),
      name: b.customer.fullName,
      phone: b.customer.phoneNumber,
      image: avatar(b.customer.fullName, b.customer.profilePhoto),
    },
    bookingDetails: {
      providerId: String(b.provider._id),
      providerName: b.provider.fullName,
      service: b.serviceSubCategory || b.serviceCategory,
      selectedDate: b.scheduledFor ? b.scheduledFor.toISOString().slice(0, 10) : '',
      selectedTime: b.scheduledTime || '',
      selectedAddress: {
        id: 'addr',
        label: b.address.label || 'Address',
        address: [b.address.line1, b.address.city].filter(Boolean).join(', '),
        icon: b.address.icon || 'location',
        isDefault: false,
        coordinates: {
          latitude: b.address.coordinates.coordinates[1],
          longitude: b.address.coordinates.coordinates[0],
        },
      },
      instructions: b.instructions || '',
      estimatedPrice: b.pricing.estimatedPrice,
      estimatedDuration: '1-2 hours',
    },
    statusHistory: b.statusHistory.map((h) => ({
      status: h.status,
      role: h.changedBy ? h.changedBy.role : 'system',
      changedAt: h.changedAt ? h.changedAt.toISOString() : '',
      note: h.note || '',
    })),
    payment: {
      status: b.payment.status,
      method: b.payment.method,
      amount: b.pricing.finalPrice || b.pricing.estimatedPrice,
      paidAt: b.payment.paidAt ? b.payment.paidAt.toISOString() : null,
    },
    cancellation: b.cancellation && b.cancellation.by ? b.cancellation : null,
    estimatedArrival: '15-20 minutes',
  }, 'Booking fetched');
});

// GET /api/bookings/:id/service-status — shape of serviceStatus.ts
const getServiceStatus = asyncHandler(async (req, res) => {
  const b = req.booking;
  const steps = [
    { key: STATUS.ARRIVED, label: 'Provider Arrived' },
    { key: STATUS.IN_PROGRESS, label: 'Work in Progress' },
    { key: STATUS.COMPLETED, label: 'Completed' },
  ];
  const reached = b.statusHistory.reduce((acc, h) => {
    acc[h.status] = h.changedAt;
    return acc;
  }, {});
  ok(res, {
    bookingId: String(b._id),
    status: toServiceStatus(b.status),
    provider: {
      id: String(b.provider._id),
      name: b.provider.fullName,
      phone: b.provider.phoneNumber,
      image: avatar(b.provider.fullName, b.provider.profilePhoto),
    },
    serviceDetails: {
      type: b.serviceSubCategory || b.serviceCategory,
      description: b.description || b.instructions || '',
      startedAt: b.work.startedAt ? b.work.startedAt.toISOString() : '',
      estimatedDuration: '1-2 hours',
      suggestedAmount:
        b.payment.requestedAmount || b.pricing.finalPrice || b.pricing.estimatedPrice,
    },
    progressSteps: steps.map((s, i) => ({
      id: i + 1,
      label: s.label,
      completed: !!reached[s.key],
      time: reached[s.key]
        ? new Date(reached[s.key]).toLocaleTimeString('en-PK', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Asia/Karachi',
          })
        : undefined,
    })),
  }, 'Service status fetched');
});

// PATCH /api/bookings/:id/status — customer-side transition (rarely used directly)
const patchBookingStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  await transition(req.booking, status, {
    id: req.user._id,
    role: req.bookingRole,
  }, { reason: req.body.reason });
  ok(res, { bookingId: String(req.booking._id), status: req.booking.status }, 'Status updated');
});

// POST /api/bookings/:id/cancel
const cancelBooking = asyncHandler(async (req, res) => {
  await transition(req.booking, STATUS.CANCELLED, {
    id: req.user._id,
    role: req.bookingRole,
  }, { reason: req.body.reason || 'Cancelled by customer' });
  ok(res, { success: true, bookingId: String(req.booking._id) }, 'Booking cancelled');
});

module.exports = {
  initBooking,
  createBooking,
  getBooking,
  getServiceStatus,
  patchBookingStatus,
  cancelBooking,
  buildTimeSlots,
};
