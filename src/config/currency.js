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

/**
 * Top-up bounds, in PKR — defined ONCE here because they were previously
 * duplicated in walletRoutes.js's validator and walletController.js's guard,
 * and both still carried USD-era numbers (max 10000) after the ledger moved
 * to PKR. PKR 10,000 is roughly USD 36, which made a realistic top-up
 * impossible.
 *
 * MIN is set by Stripe, not by us: Stripe rejects charges below ~USD 0.50,
 * and the old `min: 1` PKR converts to 0 USD cents — it could never have
 * succeeded at Stripe even though the API accepted it.
 */
const MIN_TOPUP_PKR = 150; // ≈ USD 0.54 — clears Stripe's minimum charge
const MAX_TOPUP_PKR = 500000; // ≈ USD 1,785 — sane ceiling for a demo wallet

module.exports = {
  WALLET_CURRENCY,
  STRIPE_CHARGE_CURRENCY,
  PKR_PER_USD,
  MIN_TOPUP_PKR,
  MAX_TOPUP_PKR,
  pkrToUsdCents,
  usdCentsToPkr,
};
