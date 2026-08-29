const mongoose = require('mongoose');

// ============================================================================
// Home-service notifications. Collection: `hsnotifications`.
//
// WHY A NEW MODEL RATHER THAN REUSING ONE OF THE TWO THAT EXIST
// -------------------------------------------------------------
//   - `src/models/Notification.js` keys on `adminId` and its type enum is
//     entirely admin events. It cannot address a provider or a customer.
//   - `HCNotification` is close, and deliberately already stores Provider ids
//     in its `userId` field for doctor-directed rows — but its type enum is
//     appointment/prescription vocabulary. Widening it to carry booking and
//     job events would make one enum mean two different domains.
//
// The home-service module previously had NO notification persistence at all.
// Its only "notifications" endpoint synthesized a list from booking
// statusHistory on every request, was `userOnly`, and had no read state — so a
// provider had nothing, and a customer had nothing durable.
//
// RECIPIENT IS POLYMORPHIC, and that is the whole point. `recipient` holds
// either a User `_id` (the customer) or a Provider `_id` (the provider), and
// `recipientRole` says which. The main backend's `protect` resolves both
// collections and sets `req.user` either way, so one query serves both sides
// and neither role needs its own endpoint. Ids from the two collections are
// disjoint, so a mis-set role cannot leak someone else's rows.
// ============================================================================

const hsNotificationSchema = new mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    recipientRole: {
      type: String,
      enum: ['user', 'provider'],
      required: true,
    },

    title: { type: String, required: true },
    message: { type: String, required: true },

    type: {
      type: String,
      enum: [
        // booking lifecycle — mirrors services/statusMap.js
        'booking_created',
        'booking_accepted',
        'booking_rejected',
        'booking_cancelled',
        'booking_en_route',
        'booking_arrived',
        'booking_in_progress',
        'booking_completed',
        // conversation
        'message',
        'missed_call',
        // money
        'payment_requested',
        'payment_received',
      ],
      required: true,
    },

    /** Free-form routing payload — { bookingId, roomType, ... }. */
    data: { type: mongoose.Schema.Types.Mixed, default: null },

    isRead: { type: Boolean, default: false },
    readAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// The list query: this recipient's rows, newest first.
hsNotificationSchema.index({ recipient: 1, createdAt: -1 });
// The unread badge.
hsNotificationSchema.index({ recipient: 1, isRead: 1 });

// `id` alongside `_id`, because the mobile app reads `.id`. The provider
// profile endpoint not doing this is what once left providers unable to receive
// calls — the same mistake is cheap to avoid here.
hsNotificationSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = String(ret._id);
    delete ret.__v;
    return ret;
  },
});

module.exports =
  mongoose.models.HSNotification ||
  mongoose.model('HSNotification', hsNotificationSchema, 'hsnotifications');
