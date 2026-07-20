const mongoose = require('mongoose');

/**
 * Records every processed Stripe webhook event id. Stripe retries delivery
 * (network blips, slow 2xx, etc.) — without this, a retried
 * checkout.session.completed double-credits a wallet. Processing an event
 * whose id is already here is a no-op that still returns 200 (so Stripe
 * stops retrying), per Part E.3 / STRIPE_TESTING.md.
 */
const stripeWebhookEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    processedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('StripeWebhookEvent', stripeWebhookEventSchema);
