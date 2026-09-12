const asyncHandler = require('express-async-handler');
const Booking = require('../models/Booking');
const SavedAddress = require('../models/SavedAddress');
const Provider = require('../../../models/Provider');
const { transition } = require('../services/bookingService');
const {
  STATUS,
  ACTIVE_STATUSES,
  toServiceStatus,
  toConfirmationStatus,
} = require('../services/statusMap');
const {
  toBookingProvider,
  toSavedAddress,
  avatar,
  SUBTYPE_TO_CATEGORY,
} = require('../services/serializers');

const ok = (res, data, message, pagination) =>
  res.json({ success: true, data, message, ...(pagination ? { pagination } : {}) });

// ---------------------------------------------------------------------------
// One live request per provider.
//
// A customer may have several bookings running at once — that is deliberate,
// and requests to DIFFERENT providers are how they get a job covered quickly.
// What they may not have is the same provider booked twice over, which is what
// tapping Book again produced: a second PENDING row the provider saw as two
// separate jobs, and a confirmation screen that started its wait from scratch
// while the first request was still live.
//
// So "already requested" is a first-class question, asked in three places —
// the booking form's init, the create guard, and the customer's Book buttons —
// and answered here once so all three agree.
// ---------------------------------------------------------------------------
function activeBookingQuery(customerId, providerId) {
  return {
    customer: customerId,
    provider: providerId,
    status: { $in: ACTIVE_STATUSES },
  };
}

// The shape every caller returns to the app: enough to route straight to the
// booking-status screen without a second request.
function toActiveBooking(b) {
  return {
    bookingId: String(b._id),
    providerId: String(b.provider && b.provider._id ? b.provider._id : b.provider),
    status: toConfirmationStatus(b.status),
    canonicalStatus: b.status,
    category: b.serviceCategory,
    scheduledFor: b.scheduledFor ? b.scheduledFor.toISOString() : null,
    scheduledTime: b.scheduledTime || '',
    createdAt: b.createdAt ? b.createdAt.toISOString() : '',
  };
}

async function findActiveBooking(customerId, providerId) {
  return Booking.findOne(activeBookingQuery(customerId, providerId)).sort({ createdAt: -1 });
}

// Booking screen time slots — generated, marking already-booked slots
// unavailable for the requested date.
function buildTimeSlots(bookedTimes = new Set()) {
  const defs = [
    ['09:00 AM', 'morning'], ['10:00 AM', 'morning'], ['11:00 AM', 'morning'],
    ['12:00 PM', 'afternoon'], ['02:00 PM', 'afternoon'], ['04:00 PM', 'afternoon'],
    ['05:00 PM', 'evening'], ['06:00 PM', 'evening'], ['07:00 PM', 'evening'],
  ];
  return defs.map(([time, period], i) => ({
    id: String(i + 1),
    time,
    available: !bookedTimes.has(time),
    period,
  }));
}

// PKT-midnight day bounds for a 'YYYY-MM-DD' string — same convention as
// parseScheduledFor below, so a slot query and the booking it is checking
// against always agree on which calendar day a scheduledFor instant falls on.
function dayBoundsPKT(dateStr) {
  const start = new Date(`${dateStr}T00:00:00.000+05:00`);
  if (Number.isNaN(start.getTime())) return null;
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

// The display slot labels ('02:00 PM') this provider already has a live
// booking against on the given date. PENDING and ACCEPTED (and anything
// further along — EN_ROUTE/ARRIVED/IN_PROGRESS) all hold the slot; only a
// booking that has actually ended (COMPLETED) or fallen through
// (REJECTED/CANCELLED) frees it up again — see ACTIVE_STATUSES.
//
// Scoped to ONE provider: the same date+time is perfectly bookable with a
// DIFFERENT provider, so this must never be checked across providers.
async function bookedSlotTimes(providerId, dateStr) {
  if (!dateStr) return new Set();
  const bounds = dayBoundsPKT(dateStr);
  if (!bounds) return new Set();

  const bookings = await Booking.find({
    provider: providerId,
    status: { $in: ACTIVE_STATUSES },
    scheduledFor: { $gte: bounds.start, $lt: bounds.end },
  }).select('scheduledTime');

  return new Set(bookings.map((b) => b.scheduledTime).filter(Boolean));
}

// GET /api/bookings/init/:providerId?date=YYYY-MM-DD — provider card + saved
// addresses + slots. `date` is optional (the form asks for it again once the
// customer picks a date); without it every slot comes back available, exactly
// as before a date is chosen.
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
  // A live request with this provider means the form is the wrong screen —
  // the app sends the customer to the existing booking instead of letting them
  // fill in a duplicate and meet a 409 at the end of it.
  const active = await findActiveBooking(req.user._id, provider._id);
  const booked = await bookedSlotTimes(provider._id, req.query.date);

  ok(res, {
    provider: toBookingProvider(provider),
    addresses: addresses.map(toSavedAddress),
    timeSlots: buildTimeSlots(booked),
    activeBooking: active ? toActiveBooking(active) : null,
  }, 'Booking data fetched');
});

// GET /api/bookings/active — every live booking this customer holds.
//
// Feeds the Book buttons on the provider list and the provider profile, so a
// provider the customer has already requested offers "View request" rather
// than starting a booking that cannot be created.
const getActiveBookings = asyncHandler(async (req, res) => {
  const bookings = await Booking.find({
    customer: req.user._id,
    status: { $in: ACTIVE_STATUSES },
  }).sort({ createdAt: -1 });

  ok(res, { bookings: bookings.map(toActiveBooking) }, 'Active bookings fetched');
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
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(selectedDate || '');
  if (!dateMatch) return new Date();
  // Built straight from the PKT calendar date's own y/m/d, offset by PKT's
  // fixed +05:00 — NOT by parsing local midnight into a Date and then
  // overwriting its UTC hour. That round trip silently landed on the WRONG
  // calendar day for every slot from 5 AM PKT onward (i.e. all of them:
  // buildTimeSlots only offers 9 AM–7 PM): 'T00:00:00.000+05:00' for a given
  // date is itself 19:00 UTC the day BEFORE, and setUTCHours(hour - 5, ...)
  // sets that hour on THAT UTC day rather than advancing to the intended one
  // — so "17 Sep, 2:00 PM" was stored as 16 Sep 09:00 UTC (16 Sep, 2 PM PKT),
  // a booking scheduled a full day earlier than the customer picked, and
  // invisible to anything scoping by the date the customer actually chose
  // (the per-date slot lock included).
  const [, year, month, day] = dateMatch;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), hours - 5, minutes));
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

  // The duplicate guard, server-side. The app checks before it opens the form,
  // but that check and this create are two round trips apart — long enough for
  // a double tap, a retried request, or a second device. This is the one that
  // actually holds.
  //
  // 409 with the existing booking in the body, not a bare error: the caller's
  // next move is always to open that booking, and making them ask for it again
  // is a round trip for something we already have in hand.
  const existing = await findActiveBooking(req.user._id, provider._id);
  if (existing) {
    return res.status(409).json({
      success: false,
      message: `You already have a request with ${provider.fullName || 'this provider'}.`,
      data: { activeBooking: toActiveBooking(existing) },
    });
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

  // Tell the provider a job is waiting.
  //
  // Creation is the one lifecycle event that does NOT go through transition()
  // — there is no previous status to move from — so it missed the notification
  // hook every other status change gets for free. BOOKING_EVENTS[PENDING] has
  // been sitting there addressed `to: 'provider'` with nothing calling it,
  // which is why cancellations notified and new bookings did not.
  //
  // Both are best-effort by contract, and wrapped anyway: a provider not
  // hearing about a job must never mean the customer failed to book one.
  try {
    const notify = require('../services/notificationService');
    await notify.notifyBookingStatus(booking, STATUS.PENDING, {
      customerName: req.user.fullName,
      providerName: provider.fullName,
      service: booking.serviceSubCategory || booking.serviceCategory,
    });
  } catch (e) {
    console.error(`[booking] create notify failed booking=${booking._id}: ${e.message}`);
  }

  // The durable notification above is what the bell shows on next fetch; this
  // is what updates it without one. Addressed to the provider directly, since
  // they are not in the booking's room yet.
  try {
    const { emitToUser } = require('../../../sockets');
    await emitToUser(provider._id, 'booking_created', {
      bookingId: String(booking._id),
      status: booking.status,
      service: booking.serviceSubCategory || booking.serviceCategory,
      customerName: req.user.fullName,
      scheduledFor: booking.scheduledFor,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error(`[booking] create publish failed booking=${booking._id}: ${e.message}`);
  }

  // And a push, for the case the emit above cannot cover: a provider whose app
  // is closed, which is most of them most of the time. A job request that waits
  // for the provider to next open the app is a job request they lose.
  try {
    const { pushToUser } = require('../../../sockets');
    const service = booking.serviceSubCategory || booking.serviceCategory;
    await pushToUser(provider._id, 'provider', {
      type: 'booking_created',
      title: 'New booking request',
      body: `${req.user.fullName || 'A customer'} requested ${service || 'a service'}`,
      data: { bookingId: String(booking._id), roomType: 'homeservice' },
    });
  } catch (e) {
    console.error(`[booking] create push failed booking=${booking._id}: ${e.message}`);
  }

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
    // The raw lifecycle status, because toServiceStatus() above cannot express
    // "not started yet": it collapses PENDING/ACCEPTED/EN_ROUTE/ARRIVED into
    // 'arrived', which was safe only while this screen was unreachable before
    // ARRIVED. It is reachable from ACCEPTED now (the customer's booking
    // detail offers "Service status" the moment a provider accepts), and the
    // client needs the truth to decide whether completion is even a legal move
    // — offering it earlier produced 'Illegal transition ACCEPTED → COMPLETED'.
    canonicalStatus: b.status,
    provider: {
      id: String(b.provider._id),
      name: b.provider.fullName,
      phone: b.provider.phoneNumber,
      image: avatar(b.provider.fullName, b.provider.profilePhoto),
      // Credentials for the Service Status provider card. Sent unpadded — an
      // unrated provider gets rating 0 and an empty specialty/experience, and
      // the client hides those badges rather than printing "★ 0". Every field
      // read here is already populated by `bookingAccess`.
      rating: b.provider.ratings ? Math.round((b.provider.ratings.average || 0) * 10) / 10 : 0,
      reviews: b.provider.ratings ? b.provider.ratings.count || 0 : 0,
      experience: b.provider.experience || '',
      specialty: b.provider.profession || b.provider.specialty || '',
      verified:
        b.provider.adminVerified === 'active' || b.provider.verificationStatus === 'approved',
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
      // `time` is pre-formatted in Asia/Karachi and stays for compatibility:
      // the app and this service deploy separately, so a client that has not
      // been updated yet must keep rendering something sensible.
      time: reached[s.key]
        ? new Date(reached[s.key]).toLocaleTimeString('en-PK', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Asia/Karachi',
          })
        : undefined,
      // `timeAt` is the actual instant, which is what a client should format.
      // Pinning presentation to one timezone server-side put this timeline in
      // Karachi time while everything the app formats itself was in device
      // time — the same screen disagreeing with itself for anyone abroad.
      // Formatting is the client's job; the server's job is the instant.
      timeAt: reached[s.key] ? new Date(reached[s.key]).toISOString() : undefined,
    })),
    // Payment state belongs in this payload because the customer's service
    // screen decides whether to show the payment card, and it must decide from
    // server truth. Without it the screen could only track payment in local
    // component state, which reset on focus and stranded completed-unpaid
    // bookings. Field names are exactly getBooking's, so both endpoints
    // deserialize the same way on the client.
    payment: {
      status: b.payment.status,
      method: b.payment.method,
      amount: b.pricing.finalPrice || b.pricing.estimatedPrice,
      paidAt: b.payment.paidAt,
    },
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

// POST /api/bookings/:id/complete — the CUSTOMER confirms the job is done.
//
// Kept separate from PATCH /status rather than folded into it, because this one
// has to be idempotent and transition() cannot be: ALLOWED_TRANSITIONS[COMPLETED]
// is empty, so a second call throws 'Illegal transition COMPLETED → COMPLETED'.
// The customer's phone retries — a flaky network on the tap that ends the job
// must not surface as an error on a booking that is already done.
const completeBookingByCustomer = asyncHandler(async (req, res) => {
  if (req.bookingRole !== 'customer') {
    res.status(403);
    throw new Error('Only the booking customer may confirm completion');
  }

  // Idempotent short-circuit, ahead of the state machine.
  if (req.booking.status === STATUS.COMPLETED) {
    return ok(
      res,
      { bookingId: String(req.booking._id), status: req.booking.status },
      'Booking already completed'
    );
  }

  // Everything else — the legal-move check, work.endedAt, actualDurationMinutes,
  // the booking_completed notification and the room emit — is transition()'s job.
  await transition(req.booking, STATUS.COMPLETED, {
    id: req.user._id,
    role: 'customer',
  }, { note: 'Completion confirmed by customer' });

  ok(
    res,
    { bookingId: String(req.booking._id), status: req.booking.status },
    'Service marked as completed'
  );
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
  getActiveBookings,
  createBooking,
  getBooking,
  getServiceStatus,
  patchBookingStatus,
  completeBookingByCustomer,
  cancelBooking,
  buildTimeSlots,
  bookedSlotTimes,
};
