/**
 * "Your job starts within the hour" — for accepted home-service bookings.
 *
 * Triggered by the scheduler tick (controllers/schedulerController.js). Each
 * booking is claimed with a conditional update on `notifications.reminderAt`
 * before anything is sent, so overlapping ticks can never double-send.
 */
const Booking = require('../models/Booking');
const { STATUS } = require('./statusMap');

const WINDOW_MIN = 70;
const BATCH = 200;

async function runBookingReminders(now = new Date()) {
  const due = await Booking.find({
    status: STATUS.ACCEPTED,
    'notifications.reminderAt': null,
    scheduledFor: { $gt: now, $lte: new Date(now.getTime() + WINDOW_MIN * 60000) },
  })
    .select('_id customer provider serviceCategory serviceSubCategory scheduledFor scheduledTime address.line1 address.city')
    .populate('customer', 'fullName')
    .populate('provider', 'fullName')
    .limit(BATCH)
    .lean();

  const { pushToUser } = require('../../../sockets');
  let sent = 0;
  for (const b of due) {
    const won = await Booking.updateOne(
      { _id: b._id, status: STATUS.ACCEPTED, 'notifications.reminderAt': null },
      { $set: { 'notifications.reminderAt': now } }
    );
    if (won.modifiedCount !== 1) continue;

    const service = String(b.serviceSubCategory || b.serviceCategory || 'service').toLowerCase();
    const at = b.scheduledTime || 'soon';
    const providerName = (b.provider && b.provider.fullName) || 'Your provider';
    const customerName = (b.customer && b.customer.fullName) || 'your customer';
    const where = [b.address && b.address.line1, b.address && b.address.city].filter(Boolean).join(', ');
    const data = { bookingId: String(b._id), roomType: 'homeservice' };
    const results = await Promise.allSettled([
      pushToUser((b.customer && b.customer._id) || b.customer, 'user', {
        type: 'booking_reminder',
        title: 'Coming up within the hour',
        body: `${providerName} is booked for your ${service} at ${at}.`,
        data: { ...data, audience: 'customer' },
      }),
      pushToUser((b.provider && b.provider._id) || b.provider, 'provider', {
        type: 'booking_reminder',
        title: `Job at ${at}`,
        body: `${service[0].toUpperCase()}${service.slice(1)} for ${customerName}${where ? ` — ${where}` : ''}.`,
        data: { ...data, audience: 'provider' },
      }),
    ]);
    results.forEach((r) => {
      if (r.status === 'rejected') console.error(`[booking-reminder] booking=${b._id}: ${r.reason && r.reason.message}`);
    });
    sent += 1;
  }
  return sent;
}

module.exports = { runBookingReminders, WINDOW_MIN };
