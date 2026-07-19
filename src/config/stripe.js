const Stripe = require('stripe');
const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY)
  : new Proxy({}, { get() { throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)'); } });
// NOTE: constructing Stripe with no key throws at require time, which crashes
// serverless cold starts (Vercel). The proxy defers the error to actual use.
const colors = require('colors');

if (process.env.STRIPE_SECRET_KEY) {
  console.log('✓ Stripe configured'.green);
} else {
  console.log('✗ STRIPE_SECRET_KEY missing'.red);
}

module.exports = stripe;
