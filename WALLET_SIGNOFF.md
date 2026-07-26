# WALLET_SIGNOFF.md — MetroMatrix Wallet Production Readiness

**Date:** 2026-07-26 · **Branch:** `wallet-p2-core` (backend) · **Repos:** `MetroMatrix-Backend`, `Waleed-MetroMatrix`
**Basis:** `WALLET_AUDIT.md` (Prompt 1) → fixes (Prompts 2–4) → `WALLET_QA.md` (Prompt 5, **34/34 PASS**)

## Verdict: **SIGNED OFF**, with one explicitly untested area (§4).

The wallet is one polymorphic ledger, it is reachable and live across the user view and every
provider view, money moves atomically through one service, and a real Stripe test top-up buys
real goods with every number reconciling to the exact rupee.

I am signing this off because the gate passed **after** it caught four real money bugs and each
was fixed at root cause and the whole scenario re-run clean — not because it passed first try.
It did not pass first try. §3 is the honest list.

---

## 1. Green-flag checklist, with evidence

| # | Criterion | Verdict | Evidence (actual numbers) |
|---|---|---|---|
| 1 | Stripe test top-up credits the **exact** amount | ✅ PASS | A2c: `236,363 → 286,363`, exactly +50,000. Ledger row `stripe_topup`, amount 50,000, status `completed`. |
| 2 | Wallet checkout across two brands debits exactly and splits to the rupee | ✅ PASS | A4c: child totals `4,689` == group `4,689`. A4d: debited exactly `4,689`. |
| 3 | Customer balance after = start + topup − spend, **exactly** | ✅ PASS | A4e: `281,674 == 236,363 + 50,000 − 4,689` |
| 4 | Vendor earning credited minus commission; commission in Platform ledger | ✅ PASS | A4g: Cougar +1,349, Outfitters +2,871. A4h: Platform `14,160 → 14,629` (+469). |
| 5 | Insufficient balance blocks with **no partial debit** | ✅ PASS | A5a: 400 *"you have PKR 1 but the order total is PKR 1499"*. A5b: `1 → 1`. A5c: stock `7 → 7`. |
| 6 | Refund reverses money **+ commission + stock** correctly | ✅ PASS | A6a customer `+1,499`; A6b vendor `−1,349`; A6c Platform `14,629 → 14,479` (−150); A6d stock `7 → 8`. **All three legs needed fixes** (§3). |
| 7 | Concurrency can't oversell or double-credit | ✅ PASS | C10: 2 racers for the last unit → exactly 1 won, final stock 0, never negative. C11: replay → `283,173 → 283,173`, `alreadyProcessed: true`. |
| 8 | Reconciliation nets to **zero** | ✅ PASS | C12b: held `1,172,038` == ledger net `1,172,038`, **difference 0** across 0/77 wallets. C12a: run-introduced drift `0 → 0`. |
| 9 | Same wallet renders for user **and every provider type**, no crashes | ✅ PASS | B7a vendor api 14,922 == db 14,922; B8 doctor balance 0; B8 home-service provider balance 800. All via the one `GET /wallet/me`. |
| 10 | `npx tsc --noEmit` clean; wallet tests pass | ✅ PASS | tsc: **0 errors**. Jest: **20 suites / 204 tests, all passing**. |

Additional hardening proven by the wallet test suites and `scripts/wallet-smoke.js` (9/9 PASS):

- Webhook signature verification is genuinely active — verified through the **real Stripe CLI**:
  with a mismatched secret every forwarded event returned **400**; with the matching secret,
  **zero** signature failures. (The single 500 was `checkout.session.completed` from
  `stripe trigger`, correctly rejected for missing MetroMatrix `metadata.ownerId` — a synthetic
  event, not a real top-up.)
- 10 concurrent debits against a balance covering 6 → exactly 6 succeed, final balance 0
  (`walletConcurrency.test.js`).
- `payWithSettle` / `refund` / `debitOrDefer` idempotency and overdraw refusal
  (`walletLedgerPrimitives.test.js`, 7 cases against real MongoDB).

---

## 2. Every screen the wallet appears on

All read the **one** registered slice `services/wallet/walletSlice.ts` (`store/store.ts:246`),
through the **one** shared axios instance (`networks/wallet/walletApi.ts` → `networks/network/network.ts`).
There is no second wallet slice, no second wallet screen, and no wallet-specific base URL.

| Surface | File | Confirmed |
|---|---|---|
| Wallet screen (role-aware) | `screens/user/wallet/WalletScreen.tsx` | ✅ one screen; provider-only sections for pending vs available, Connect state, payout (`:484`, `:699`) |
| Top-up return | `screens/user/wallet/TopUpWebViewScreen.tsx` | ✅ refetches and **polls up to 30s**, with an honest "processing" state — never a stale balance |
| Transaction history | `screens/user/wallet/TransactionHistoryScreen.tsx` | ✅ reads `GET /wallet/transactions`; same screen for user and provider (backend resolves wallet from JWT) |
| MiniWalletCard | `components/MiniWalletCard/MiniWalletCard.tsx` | ✅ one component, live balance |
| User home / sidebar | `components/SlideOutSidebar/SlideOutSidebar.tsx:340` | ✅ |
| Shopping home | `screens/Shopping/User/ShoppingHome/ShoppingHomeScreen.tsx:332` | ✅ MiniWalletCard |
| Healthcare home | `screens/user/healthcare/home/healthcareHome.tsx:549` | ✅ MiniWalletCard |
| Home-services home | `screens/user/homeservice/tabs/home-screen/index.tsx:248` | ✅ MiniWalletCard |
| **Vendor** dashboard | `screens/Shopping/Brand/BrandHome/BrandHomeScreen.tsx:119` | ✅ MiniWalletCard |
| **Doctor** dashboard | `screens/providers/healthcare/doctor-home/doctorHome.tsx:273` | ✅ MiniWalletCard |
| **Home-service provider** dashboard | `screens/providers/homeservice/tabs/dashboard/dashboard.tsx:507` | ✅ MiniWalletCard |
| Shopping checkout payment | `screens/Shopping/User/CheckoutPayment/CheckoutPaymentScreen.tsx:188` | ✅ same balance + top-up link |
| Healthcare appointment payment | `screens/user/healthcare/AppointmentPayment/AppointmentPaymentScreen.tsx:157` | ✅ same balance + top-up link |
| Home-services payment | `screens/user/homeservice/payment-screen/payment.tsx:305,700` | ✅ same balance + top-up link |
| Payout / transfer sheets | `components/wallet/PayoutSheet.tsx`, `TransferSheet.tsx` | ✅ same slice |
| User profile / HS-provider profile | `screens/user/shared/profile/UserProfileScreen.tsx:218`, `screens/providers/homeservice/profile-screen/profile.tsx:312` | ✅ navigate to the shared route |

`WalletScreen` is registered in the **root** route map (`navigation-maps/Base.tsx:629,653,661`),
so every module and dashboard reaches the same screen; `DoctorStack` inherits it rather than
re-registering.

---

## 3. What the gate caught — do not skip this

The wallet would have looked green without these. Each was invisible to 197 passing tests and
both smoke scripts.

1. **Top-ups silently failed to credit under latency (P0).** `applyTopUp` inferred "new
   transaction?" from `Date.now() - createdAt < 1000`. Against a remote database that window
   routinely lapses, and when it did the credit was skipped entirely — 200 returned, ledger row
   stuck `pending`, customer charged with nothing to show. Fixed with an atomic
   `pending → completed` claim. **This is the exact failure mode the whole exercise warns about**,
   surviving in a second location after the raw-body fix.
2. **Refunds kept the platform commission (P0).** `reversePayout()` claimed in its own doc
   comment to reverse commission and never did — inventing PKR 150 per refund and breaking
   reconciliation by exactly that. Fixed.
3. **Returned goods never re-entered stock (P1).** `refunded` reversed all three money legs but
   never restored inventory; only `cancelled` did. Fixed.
4. **Top-up bounds were still USD (P1).** Max 10,000 on a **PKR** ledger (~USD 36) made the
   specified 50,000 top-up impossible; min 1 PKR converted to **0 USD cents**, below Stripe's
   minimum charge. Bounds centralised in `config/currency.js`.

Plus, from the audit phase: `payWithSettle()` was referenced in two doc comments as the
prescribed payer-leg primitive but **had never been implemented**, so shopping and healthcare
each hand-rolled a raw debit. Implemented, along with `refund()` and `debitOrDefer()`, and every
production money path routed through them.

---

## 4. Not proven — read before demoing

**A real Stripe Connect payout to a bank was never exercised.** No seeded vendor has completed
Connect onboarding, so `POST /wallet/payout` stops at *"Stripe Connect account not set up"*.
What **is** proven: the endpoint authorises, resolves the correct provider wallet, rejects
over-balance requests, and enforces the onboarding prerequisite. What is **not** proven: a
successful `stripe.transfers.create` + `payouts.create` round trip and the resulting balance
movement. If a payout demo matters, complete Connect onboarding for one seeded vendor first.

This is an environment gap, not a known defect — but it is untested, and calling it "green"
would be exactly the kind of self-graded pass this process exists to prevent.

---

## 5. Reproduce it yourself

```bash
# ── backend ──────────────────────────────────────────────────────────
cd MetroMatrix-NodeBackend/MetroMatrix-Backend
# .env needs MONGODB_URI, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (see STRIPE_TESTING.md)

node scripts/seed-shopping.js          # Cougar + Outfitters catalogue, vendors, QA shoppers
node src/server.js                     # or: npm run dev

# prove the webhook really verifies (separate terminal)
stripe listen --forward-to localhost:5000/api/wallet/webhook
#   → copy the whsec_... it prints into STRIPE_WEBHOOK_SECRET, restart the server
#   → mismatched secret gives 400 on every event; matching secret gives 200

# top up + buy + reconcile, all asserted
API_URL=http://localhost:5000 node scripts/wallet-qa-gate.js     # expect 34/34 PASS
API_URL=http://localhost:5000 node scripts/wallet-smoke.js       # expect 9/9 PASS

npx jest --runInBand                   # 20 suites / 204 tests
# NOTE: if this fails with "jest: Permission denied", use:
#   node node_modules/jest/bin/jest.js --runInBand

# one-time only, if reconciliation shows historical drift (adds ledger rows,
# never changes a balance; idempotent)
node scripts/wallet-reconcile-repair.js --dry
node scripts/wallet-reconcile-repair.js

# ── frontend ─────────────────────────────────────────────────────────
cd MetroMatrix/Waleed-MetroMatrix
npx tsc --noEmit                       # expect zero errors
```

**Seeded logins used by the gate**

| Role | Email | Password | Login route |
|---|---|---|---|
| Customer | `shopper1.qa@metromatrix.pk` | `Shopper@123` | `/api/auth/login` |
| Customer 2 | `shopper2.qa@metromatrix.pk` | `Shopper@123` | `/api/auth/login` |
| Vendor (Cougar) | `vendor.cougar@metromatrix.pk` | `Vendor@123` | `/api/auth/provider/login` |
| Vendor (Outfitters) | `vendor.outfitters@metromatrix.pk` | `Vendor@123` | `/api/auth/provider/login` |
| Doctor | `doctor1.hc@metromatrix.pk` | `Doctor@123` | `/api/auth/provider/login` |
| Home-service provider | `provider1.hs@metromatrix.pk` | `Provider@123` | `/api/auth/provider/login` |

> Providers use `/api/auth/provider/login`, **not** `/api/auth/login`. Worth knowing before a viva.

---

## 6. Open items — all non-blocking

| Item | Severity | Why it is not blocking |
|---|---|---|
| Stripe Connect payout untested end-to-end (§4) | **Known gap** | Environment, not code. Documented rather than implied-green. |
| `settle()` sequential fallback has no compensating rollback (`walletService.js`, audit P1-3) | P1, unreachable here | Only reachable without a replica set. Atlas provides one; each leg is individually atomic. |
| `scripts/smoke-wallet.js` vs `scripts/wallet-smoke.js` (audit P2-1) | P2 cosmetic | Not duplicates — service-level vs HTTP/Stripe end-to-end. Names invite running the wrong one; suggest renaming to `smoke-wallet-service.js` / `smoke-wallet-stripe.js`. |
| `jest` binary lacks the exec bit (audit P2-4) | P2 environmental | Workaround documented in §5. |
| Historical opening-balance adjustments now in the ledger | Informational | 17 rows, PKR 180,906, each tagged `metadata.openingBalanceAdjustment`. No balance was altered. |

---

## 7. Status of work

- **Backend:** branch `wallet-p2-core`, commits `9d84b6e` (ledger centralisation) and
  `84fa8fc` (gate + 4 money-bug fixes). **Committed locally, not pushed, not deployed.**
- **Frontend:** no changes were required — Prompt 4 was already complete and verified
  (one slice, shared axios, root registration, 7 MiniWalletCard surfaces, tsc clean).
- **Database:** the shared Atlas dev database was written to by the gate (orders, top-ups,
  refunds) and by the one-time reconciliation repair. Balances were only ever moved through
  `WalletService`; the repair added ledger rows only.
