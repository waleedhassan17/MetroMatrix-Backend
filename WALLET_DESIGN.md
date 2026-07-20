# WALLET_DESIGN — the one ledger, how it broke, and how it's fixed

Reference document for `W1` (wallet centralisation + Stripe fix). Read this before touching wallet code
in any module — home services, healthcare, or shopping.

---

## PART A — the webhook bug that made every top-up silently fail

`src/app.js` applied `express.json()` globally near the top of the file, and mounted the Stripe webhook
route 1,500 lines later via `app.use('/api/wallet', walletRoutes)`. By the time a webhook request reached
`express.raw({ type: 'application/json' })` inside `walletRoutes.js`, the global JSON parser had already
consumed and parsed the request stream — `req.body` arrived at `stripe.webhooks.constructEvent(req.body,
sig, webhookSecret)` as a plain JS object, not the raw `Buffer` signature verification requires.

**Result:** every webhook call failed signature verification and returned 400. In test mode this meant a
completed Stripe checkout never credited the wallet — Stripe showed "success", the wallet showed nothing,
and nothing in the logs made this obvious unless you were specifically watching `stripe listen`'s output.

**Fix:** the webhook route is now mounted directly in `app.js`, with `express.raw()`, BEFORE
`express.json()` runs:

```js
app.post('/api/wallet/webhook', express.raw({ type: 'application/json' }), stripeWebhook);
app.use(express.json({ limit: '10mb' }));
```

The duplicate route was removed from `walletRoutes.js` (left as a comment pointing here, so nobody re-adds
it). `stripeWebhook` now throws loudly if `req.body` is ever not a `Buffer` — this can't silently
regress again. `src/__tests__/stripeWebhook.test.js` proves the property with a signed-payload test, a
bad-signature test, a replay-idempotency test, and a regression test for the exact original failure mode.

## PART B — read-modify-write balances were a race condition

`Wallet.credit()`/`Wallet.debit()` did `this.balance += amount; return this.save()`. Two concurrent debits
against the same wallet can both read the same `balance`, both compute a new value from it, and the second
`save()` silently clobbers the first — a wallet can be overdrawn, or a credit can vanish, with no error
anywhere.

**Fix:** `Wallet.creditAtomic(walletId, amount)` / `Wallet.debitAtomic(walletId, amount)` do the
sufficiency check AND the write in one `findOneAndUpdate` with `$inc` — MongoDB serializes concurrent
writes to the same document, so the check-then-write gap that caused the race no longer exists. The old
instance methods are now thin deprecated wrappers around these statics, so every existing call site
(`wallet.credit(x)`, `wallet.debit(x)`) got atomic for free without an editing pass across three modules.
`transferFunds`'s manual `s.balance = ...; save()` inside its Mongoose session was replaced with the
atomic statics too (session-aware).

**Required proof** (`src/__tests__/walletConcurrency.test.js`, live MongoDB, not mocks): 10 concurrent
1-unit debits against a wallet with balance 6 → exactly 6 succeed, 4 fail with `'Insufficient balance'`,
final balance exactly 0.

## PART C — one ledger across three modules, and where commission actually went

Before this PR, home services, healthcare, and shopping each independently called
`wallet.credit()`/`wallet.debit()` with their own ad-hoc commission math. Reading `orderService.js` and
`paymentService.js` (healthcare) side by side revealed the SAME bug in both: the vendor/doctor's payout
was computed as `amount - commission`, credited to their wallet — and `commission` itself was never
credited anywhere. It existed as a number in a log message and nowhere else. Summed across every completed
booking/appointment/order, that's real money the ledger simply cannot account for.

**Fix, in three pieces:**

1. **`WalletTransaction.relatedTo: { kind, id }`** — every transaction this PR touches now points back to
   the Booking/Appointment/Order/OrderGroup/PayoutRequest that caused it.
2. **A `Platform` wallet** (`Wallet.ownerType: 'Platform'`, one singleton document at a fixed sentinel
   owner id, `WalletService.PLATFORM_OWNER_ID`) — commission has a real, queryable destination.
3. **Two shared primitives on `WalletService`**, so payment logic lives in one place:
   - **`settle()`** — atomic single-shot payer→payee(−commission)+Platform transfer, for flows where both
     sides settle right now. Home services' wallet payment (customer pays, provider earns, in the same
     call) is the natural fit.
   - **`settlePayout()` / `reversePayout()`** — the payee+commission leg for flows where the customer pays
     at ONE lifecycle event and the provider earns at a LATER one. Healthcare (pay at booking, doctor paid
     at appointment completion) and shopping (pay at checkout, vendor paid at delivery) both work this way
     **deliberately** — the customer's money should not reach the provider before the service is actually
     rendered, so a cancellation before completion never has to claw back a payout that already landed.
     That's a real business rule, not an oversight, so `settle()` — which is genuinely atomic and
     all-or-nothing — is the wrong shape for it. `settlePayout()` credits the payee and the Platform
     commission leg without touching a payer (the payer already paid, earlier, through their module's own
     debit call); `reversePayout()` is the refund/return-side undo, idempotent.

All three modules' existing payout code (`homeservice/services/paymentService.js`'s `payWithWallet` and
`confirmCash`, `healthcare/services/paymentService.js`'s `settleCompletedAppointment`,
`shopping/services/orderService.js`'s `payoutVendor`/`reverseVendorPayout`) now call these primitives
instead of doing their own debit/credit pairs. `WalletTransaction.source` gained per-module values
(`homeservice_payment`, `homeservice_earning`, `healthcare_payment`, `healthcare_earning`,
`shopping_payment`, `shopping_earning`, `commission`) — the original values are all kept for migration
safety.

**A known, disclosed consequence — read this before trusting the reconciliation number on this
database.** The historical `service_payment`-sourced transactions (pre-existing seed data and pre-fix code
runs) already have this exact vanishing-commission gap baked in: debits total far more than credits for
that source, because old commission math never landed anywhere. `GET /api/admin/wallets/reconciliation`
will show real, non-zero drift on this database **because of that historical data**, not because the fix
is wrong. `src/__tests__/adminWallet.test.js` proves the fixed code path's marginal correctness instead of
asserting a clean historical slate: a fresh top-up→`settle()` cycle, run entirely through the fixed code,
adds zero additional drift to whatever the pre-existing baseline was. Going forward, activity reconciles
cleanly; the historical ledger does not, and reconciliation is supposed to surface exactly that rather than
hide it.

`GET /api/wallet/transactions` — one endpoint for both users and providers (wallet resolved from the JWT),
filterable by `source`, `module` (derived grouping: homeservice/healthcare/shopping/topup/payout), `type`,
and date range. Backs the frontend's unified transaction-history screen.

## PART D — currency: PKR ledger, USD Stripe test-mode charges

Every price in this app is PKR. Stripe does not support PKR as a charge currency and does not operate in
Pakistan at all — live PKR charges through Stripe are not possible regardless of configuration, so this was
never a real choice between "PKR everywhere" and "USD everywhere"; it was a choice about where the
unavoidable conversion boundary sits.

**Decision: (a) — ledger in PKR, Stripe charges in USD test mode at one fixed documented rate.**
`src/config/currency.js`: `WALLET_CURRENCY = 'PKR'`, `PKR_PER_USD = 280` (fixed for the demo, explicitly
NOT a live FX rate), with `pkrToUsdCents()`/`usdCentsToPkr()` helpers. `Wallet.currency` and
`WalletTransaction.currency` both default to `'PKR'`. `createCheckoutSession` converts the requested PKR
amount to USD cents at the boundary; `applyTopUp` converts back and stamps `metadata.fxRate` on the
transaction so historical records stay accurate if the constant ever changes. `requestPayout` (Stripe
Connect) applies the same conversion for the same reason.

**Why not (b), USD everywhere for the demo:** every screen in the app already shows PKR — search filters,
booking prices, cart totals, all of it. Displaying USD anywhere in the wallet would be the one place in the
whole product that doesn't match what the user sees everywhere else, which is a worse look in a demo than
a clearly-labelled, documented FX constant at the Stripe boundary. Production would replace Stripe entirely
with a Pakistani gateway (JazzCash, Easypaisa, or PayFast) that charges in PKR directly — at that point this
conversion layer disappears rather than needing to be "fixed".

## PART E — Stripe test harness

- `.env.example` documents every variable, with the Stripe section explaining what each key is for and
  pointing at `STRIPE_TESTING.md` for the full walkthrough (test keys, `stripe listen`, test card numbers,
  Connect onboarding, and four escalating ways to prove signature verification is genuinely working).
- Found and fixed a real latent bug while writing the `.env.example` comments: `APP_DEEP_LINK_SCHEME` is
  read in four places (top-up success/cancel pages, Connect onboarding refresh/return pages) but was never
  set in `.env` — every one of those redirect pages would have deep-linked to the literal string
  `undefined://wallet/...`. Added a `'metromatrix'` fallback (matching the frontend's actual `app.json`
  scheme) so this degrades safely, and documented the variable so it gets set explicitly going forward.
- `src/config/stripe.js` fails fast and loud at boot when `STRIPE_SECRET_KEY` is missing in production
  (throws, refuses to start — a production deploy with no Stripe key silently breaking every payment on
  first use is worse than never starting); warns and degrades in development so the app still boots for
  anyone cloning the repo who isn't working on payments that day.
- `StripeWebhookEvent` records every processed event id with a unique index — replaying an
  already-processed webhook (Stripe retries on anything short of a fast 2xx) is a guaranteed no-op, not a
  double-credit race.
- `scripts/wallet-smoke.js` — runs against a live server with real Stripe test-mode credentials: creates a
  user, a real Stripe checkout session, signs a webhook payload with the SDK's own test-signing helper
  (`stripe.webhooks.generateTestHeaderString`), posts it, asserts the balance in the database actually
  increased, settles a payment to a provider and asserts the commission landed in the Platform ledger,
  replays the same event id and asserts no double-credit. **Run live against the real Stripe test API and
  the real database: 9/9 passing.**

## PART F — admin wallet oversight

`src/routes/adminWalletRoutes.js`, mounted at `/api/admin/wallets`:

- `GET /` — all wallets, owner type/name/email resolved, balance, last activity, searchable by owner name
  or email, paginated.
- `GET /:id/transactions` — full paginated ledger for one wallet.
- `POST /:id/adjust` — manual credit/debit. Reason is **mandatory** (400 without one); writes a
  `WalletAuditLog` entry (admin id, before/after balance, reason) and a `WalletTransaction` with source
  `admin_adjustment`, going through the same atomic statics as everything else.
- `GET /reconciliation` — `totalUserBalance + totalProviderBalance + platformCommissionBalance` compared
  against `totalToppedUp - totalPaidOut + netAdjustments`. Wallet-to-wallet transfers (P2P, `settle()`,
  `settlePayout()`, commission legs) are deliberately excluded from the expected-value side of the formula
  — by construction they move balance between wallets without creating or destroying money, so a
  correctly-functioning transfer never appears in this comparison at all. See the disclosed historical-drift
  note in Part C above before treating a non-zero `drift` on this database as a new bug.

`src/__tests__/adminWallet.test.js` (live MongoDB): mandatory-reason rejection, successful adjustment +
audit trail, insufficient-balance rejection, and the marginal-reconciliation proof described in Part C.

---

## Running the wallet test suite

`npm test` now runs Jest with `--runInBand`. The suite mixes fast mocked unit tests with several live
MongoDB integration tests (`walletConcurrency`, `walletSettle`, `adminWallet`) that mutate global
aggregate wallet state — running them in parallel worker processes caused exactly the kind of cross-test
interference the reconciliation test is designed to catch in production code, just from Jest's own workers
instead. Serial execution costs about 30 extra seconds on the full suite; it's the correct trade for tests
whose entire point is proving global-ledger correctness.
