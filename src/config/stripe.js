const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const colors = require('colors');

if (process.env.STRIPE_SECRET_KEY) {
  console.log('✓ Stripe configured'.green);
} else {
  console.log('✗ STRIPE_SECRET_KEY missing'.red);
}

module.exports = stripe;
