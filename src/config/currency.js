/**
 * Wallet currency decision (Part D) — see WALLET_DESIGN.md for the full
 * reasoning. Summary: the ledger is denominated in PKR because every price
 * in the app already is. Stripe does not support PKR as a charge currency
 * and does not operate in Pakistan at all, so top-up charges run through
 * Stripe TEST MODE in USD using the fixed conversion rate below. The rate is
 * stamped onto every top-up WalletTransaction (metadata.fxRate) so past
 * records stay accurate even if this constant is ever changed.
 */

// Ledger currency — every Wallet and WalletTransaction defaults to this.
const WALLET_CURRENCY = 'PKR';

// Stripe charge currency — PKR is not chargeable, so top-ups run in USD
// test mode. This is a documented, fixed conversion constant for FYP demo
// purposes only; production would replace Stripe with a Pakistani gateway
// (JazzCash / Easypaisa / PayFast) that charges in PKR directly.
const STRIPE_CHARGE_CURRENCY = 'usd';
const PKR_PER_USD = 280; // fixed for the demo; NOT a live FX rate

/** amountPkr -> integer USD cents for a Stripe line_item unit_amount */
function pkrToUsdCents(amountPkr) {
  return Math.round((amountPkr / PKR_PER_USD) * 100);
}

/** Stripe's amount_total (USD cents) -> whole PKR credited to the wallet */
function usdCentsToPkr(amountCents) {
  return Math.round((amountCents / 100) * PKR_PER_USD);
}

module.exports = {
  WALLET_CURRENCY,
  STRIPE_CHARGE_CURRENCY,
  PKR_PER_USD,
  pkrToUsdCents,
  usdCentsToPkr,
};
