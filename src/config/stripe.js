const Stripe = require('stripe');
const colors = require('colors');

const isProduction = process.env.NODE_ENV === 'production';

if (!process.env.STRIPE_SECRET_KEY) {
  if (isProduction) {
    // Fail fast and loud: a production deploy with no Stripe key means
    // every top-up/payout silently breaks the moment a real customer hits
    // it. Better to never come up than to come up broken.
    console.log('✗ STRIPE_SECRET_KEY missing in production — refusing to start'.red.bold);
    throw new Error(
      'STRIPE_SECRET_KEY is required in production. Set it before starting the server.'
    );
  }
  console.log(
    '⚠ STRIPE_SECRET_KEY missing — Stripe calls will throw when used. This is fine for local ' +
      'dev on non-wallet features, but see STRIPE_TESTING.md before testing wallet top-ups.'.yellow
  );
}

const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY)
  : new Proxy({}, { get() { throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)'); } });
// NOTE: constructing Stripe with no key throws at require time, which crashes
// serverless cold starts (Vercel). The proxy defers the error to actual use —
// only reachable in development, since production already threw above.

if (process.env.STRIPE_SECRET_KEY) {
  console.log('✓ Stripe configured'.green);
}

module.exports = stripe;
