# WALLET_AUDIT.md — MetroMatrix Wallet Surface Map

**Date:** 2026-07-26 · **Repos:** `MetroMatrix-Backend` (backend), `Waleed-MetroMatrix` (frontend)
**Scope:** read-only audit per Usama-wallet.md PROMPT 1.

> **Important context for the reader.** This audit was run *after* a prior session had
> already landed the W1 (backend) and W2 (frontend) wallet work. So this is not a map of a
> broken wallet — it is a map of a **largely-fixed** wallet, with the residue that is
> genuinely still outstanding called out honestly in §4. Where a defect described in
> Usama-wallet.md has already been fixed, this document says so and cites the code, rather
> than repeating the original bug report as if it were still live.
>
> Relevant prior commits: `307ef75` (W1 A–D), `ba97637` (W1 C.5 + E), `6962d76` (W1 F),
> `5309547` (W2 frontend centralization).

---

## 0. The core claim, confirmed

`src/models/Wallet.js` is **one polymorphic ledger**:

| Property | Value | Line |
|---|---|---|
| `owner` | ObjectId, `refPath: 'ownerType'` | `Wallet.js:18-22` |
| `ownerType` | enum `['User', 'Provider', 'Platform']` | `Wallet.js:29-36` |
| `balance` | Number, `min: 0` | `Wallet.js:42-46` |
| `currency` | default `PKR` | `Wallet.js:52-56` |
| unique index | `{ owner: 1, ownerType: 1 }` | `Wallet.js:67` |

**Confirmed:** one wallet per user, one per provider. The audit brief anticipated
`User | Provider`; the shipped model adds a third `Platform` member — the singleton
commission ledger (`WalletService.PLATFORM_OWNER_ID`, a fixed sentinel ObjectId
`000000000000000000000001`, `walletService.js:11`). Platform has no backing User/Provider
document, so `refPath` population is meaningful only for the first two.

---

## 1. Backend surface

### 1.1 Endpoints

All under `/api/wallet` (`src/routes/walletRoutes.js`), controller
`src/controllers/walletController.js` unless noted.

**Top-up / Stripe**

| Method | Path | Guard | Controller |
|---|---|---|---|
| POST | `/api/wallet/webhook` | *signature only* — mounted in `app.js`, **not** in walletRoutes | `stripeWebhook` (`:401`) |
| POST | `/topup/checkout` | `protect` + validators | `createCheckoutSession` (`:112`) |
| GET | `/topup/success` | **public** (Stripe redirect) | `topUpSuccess` (`:183`) |
| GET | `/topup/cancel` | **public** (Stripe redirect) | `topUpCancel` (`:293`) |

**Balance / transactions read**

| Method | Path | Guard | Controller |
|---|---|---|---|
| GET | `/me` | `protect` | `getMyWallet` (`:85`) |
| GET | `/transactions` | `protect` | `getMyTransactions` (`:37`) |

Both resolve the wallet from the JWT, so the *same* endpoints serve users and providers —
this is what lets one frontend screen serve both roles.

**Payments (per module)** — no wallet-owned endpoints; each module's own controller calls
`WalletService`. See §1.4.

**Payouts / Connect**

| Method | Path | Guard | Controller |
|---|---|---|---|
| POST | `/connect/onboard` | `protect` | `startConnectOnboarding` (`:575`) |
| GET | `/connect/status` | `protect` | `getConnectStatus` (`:625`) |
| GET | `/connect/refresh` | **public** (Stripe redirect) | `connectRefresh` (`:677`) |
| GET | `/connect/return` | **public** (Stripe redirect) | `connectReturn` (`:682`) |
| POST | `/payout` | `protect` + validators | `requestPayout` (`:690`) |
| POST | `/transfer` | `protect` + validators | `transferToWallet` (`:511`) |

**Admin** (`src/routes/adminWalletRoutes.js`, guard `[protect, adminOnly]`,
controller `adminWalletController.js`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/reconciliation` | system-wide reconciliation report |
| GET | `/` | list wallets |
| GET | `/:id/transactions` | one wallet's ledger |
| POST | `/:id/adjust` | manual credit/debit adjustment |

> The dead `/webhook` route **has already been removed** from `walletRoutes.js`
> (Prompt 2A). Verified: no `router.post('/webhook', …)` remains.

### 1.2 `src/services/walletService.js` — exported functions

| Function | What it does |
|---|---|
| `getOrCreateWallet(ownerId, ownerType)` | find-or-create; validates ownerType ∈ User/Provider/Platform |
| `getPlatformWallet()` | the singleton commission wallet, created on first use |
| `getWalletWithTransactions(ownerId, ownerType, {limit,page})` | wallet + paginated ledger |
| `recordTransaction(walletId, {...})` | writes a `WalletTransaction`; idempotent on `stripeSessionId` |
| `applyTopUp(stripeSession)` | webhook entry point: USD cents → PKR, credit, flip txn to `completed`, in a session when a replica set is available |
| `transferFunds({...})` | P2P transfer with optional fee; idempotent via `idempotencyKey` |
| **`settle({...})`** | **the one-shot ledger primitive** — debit payer, credit payee minus commission, credit Platform the commission, write linked txns |
| `settlePayout({...})` | payee+commission leg only, for pay-now/earn-later modules |
| `reversePayout({...})` | reverses a `settlePayout` on refund; idempotent |
| `initiatePayout({...})` | reserves funds for a Stripe payout (debits immediately) |
| `attachStripePayoutIds(txId, {...})` | stamps Stripe ids on a pending payout txn |
| `markPayoutSucceeded(stripePayoutId)` | idempotent success flip |
| `markPayoutFailedAndRefund(stripePayoutId, reason)` | idempotent failure + refund |

**`PLATFORM_OWNER_ID`** is exported as a static.

> ⚠️ **`payWithSettle()` is documented but does not exist.** It is referenced in two doc
> comments (`walletService.js:454` and `:619`) as the prescribed payer-leg primitive for
> pay-now/earn-later modules, but **it is defined nowhere in the codebase** and called
> nowhere. Verified by grep. This is the root cause of defect **P1-1** in §4 — the payer
> legs of shopping and healthcare each hand-roll the debit the missing function was meant
> to encapsulate.

### 1.3 Every balance-mutation site

Grep: `\.balance\s*[-+]*=|\$inc:\s*{\s*balance|\.credit\(|\.debit\(|creditAtomic|debitAtomic`,
excluding `__tests__`.

**Canonical (inside the ledger primitives) — these are correct:**

| File:line | Call |
|---|---|
| `src/models/Wallet.js:76` | `creditAtomic` static (definition) |
| `src/models/Wallet.js:89` | `debitAtomic` static (definition, with `{balance:{$gte:amount}}` guard) |
| `src/models/Wallet.js:107` | `findOrCreate` upsert (definition) |
| `src/models/Wallet.js:123,132` | deprecated `credit`/`debit` instance methods — now **thin wrappers** delegating to the atomic statics |
| `src/services/walletService.js:194,204` | `applyTopUp` credit |
| `src/services/walletService.js:296-297,361-362` | `transferFunds` legs |
| `src/services/walletService.js:523-525` | `settle` legs (debit payer, credit payee, credit Platform) |
| `src/services/walletService.js:659,675` | `settlePayout` legs |
| `src/services/walletService.js:725` | `reversePayout` debit |
| `src/services/walletService.js:775,824` | `initiatePayout` / `markPayoutFailedAndRefund` |

**Outside `walletService` — the orphan-mutation set (defect P1-1):**

| File:line | Call | Module | Note |
|---|---|---|---|
| `src/modules/shopping/services/checkoutService.js:182` | `customerWallet.debit(totals.total)` | shopping | payer leg of checkout |
| `src/modules/shopping/services/checkoutService.js:195` | `customerWallet.credit(totals.total)` | shopping | compensating rollback |
| `src/modules/shopping/services/orderService.js:133` | `wallet.credit(order.total)` | shopping | customer refund |
| `src/modules/healthcare/services/paymentService.js:93` | `wallet.debit(amount)` | healthcare | payer leg of appointment payment |
| `src/modules/healthcare/services/paymentService.js:142` | `wallet.credit(refund)` | healthcare | cancellation refund |
| `src/modules/homeservice/controllers/adminController.js:192` | `wallet.credit(refundAmount)` | homeservice | admin refund |
| `src/modules/homeservice/controllers/adminController.js:301` | `wallet.credit(refundAmount)` | homeservice | dispute refund |
| `src/modules/homeservice/controllers/adminController.js:316` | `pWallet.debit(penalty)` | homeservice | dispute penalty |
| `src/modules/homeservice/controllers/adminController.js:404` | `wallet.debit(p.amount)` | homeservice | payout approval |
| `src/controllers/walletController.js:800` | `w.credit(numAmount)` | core | fallback refund after Stripe payout failure |
| `src/modules/shopping/seed/brands.seed.js:485` | `wallet.credit(amount)` | seed | **not a defect** — seed data only |
| `src/controllers/adminWalletController.js:155-156` | `creditAtomic`/`debitAtomic` | admin | **not a defect** — deliberate admin adjustment, uses atomic statics directly |

**Severity nuance that matters.** Since `307ef75`, the deprecated `credit()`/`debit()`
instance methods delegate to the atomic statics (`Wallet.js:123-136`). So every site above
is **already race-safe** — `debit()` still carries the `$gte` guard and still throws
`'Insufficient balance'`. These are therefore **not money-corrupting**. What they are is a
**centralisation and ledger-completeness** failure: they mutate a balance without going
through the one service, so Prompt 5's step-13 re-grep cannot come back clean, and each
call site must remember to write its own `WalletTransaction` (they all currently do, but
nothing enforces it).

### 1.4 How each module moves money today

| Module | Payer leg | Payee leg | Refund | Uses shared service? |
|---|---|---|---|---|
| **Home services** | `WalletService.settle()` (`homeservice/services/paymentService.js:51`) | same `settle()` call | admin controller, hand-rolled | ✅ **fully** for the main path |
| **Healthcare** | hand-rolled `wallet.debit()` + `recordTransaction` (`paymentService.js:93-102`) | `WalletService.settlePayout()` (`:194`) | hand-rolled `wallet.credit()` (`:142`) | ⚠️ **payee leg only** |
| **Shopping** | hand-rolled `wallet.debit()` + `recordTransaction` (`checkoutService.js:182-193`) | `WalletService.settlePayout()` (`orderService.js:159`) | hand-rolled `wallet.credit()` (`orderService.js:133`); vendor side via `reversePayout()` (`:183`) | ⚠️ **payee leg only** |

Home services additionally routes **cash-collected commission** through `settle()` with
`payeeType: 'Platform'` (`homeservice/services/paymentService.js:105`) — the cleanest use
of the primitive in the codebase.

**Why the split is deliberate, not sloppy:** healthcare and shopping *pay at booking/checkout*
but *earn at completion/delivery*, so the customer's money must not reach the provider before
the service is rendered. A single `settle()` call cannot express that two-phase shape, which
is exactly why `payWithSettle()` was specified — and then never written.

---

## 2. Stripe path

### 2.1 Top-up trace: button → balance

1. **Frontend** `WalletScreen` → `walletApi.createTopUpSession(amount)` → `POST /api/wallet/topup/checkout`.
2. **`createCheckoutSession`** (`walletController.js:112`) converts PKR → USD cents
   (`pkrToUsdCents`, `config/currency.js`), creates the Stripe Checkout Session with
   `metadata: { ownerId, ownerType }`, returns the URL.
3. **Frontend** opens it in `TopUpWebViewScreen`.
4. **Stripe** charges the card, then POSTs `checkout.session.completed` to
   `/api/wallet/webhook`.
5. **`stripeWebhook`** verifies the signature, records the event id for idempotency, calls
   `WalletService.applyTopUp(session)`.
6. **`applyTopUp`** (`walletService.js:137`) converts USD cents → PKR (`usdCentsToPkr`),
   `getOrCreateWallet`, `recordTransaction` (idempotent on `stripeSessionId`), then
   `Wallet.creditAtomic` + flip txn to `completed` inside a session when available.

### 2.2 Where it *used* to break — and its current state

**Original defect (as described in Usama-wallet.md): FIXED.** The global `express.json()`
consumed the body before the webhook's `express.raw()`, so `constructEvent()` received a
parsed object instead of a Buffer and **every** signature verification failed — the card was
charged in test mode but the wallet was never credited.

**Current `src/app.js`:**

| Line | Content |
|---|---|
| `46-51` | comment explaining the incident |
| **`52-56`** | `app.post('/api/wallet/webhook', express.raw({ type: 'application/json' }), stripeWebhook)` |
| **`59`** | `app.use(express.json({ limit: '10mb' }))` |

**The raw mount at line 52 precedes the global JSON parser at line 59.** ✅ Correct.

**Buffer guard:** present, `walletController.js:407-412` — throws loudly if `req.body` is
not a Buffer, so the bug cannot silently return.

### 2.3 Webhook idempotency

**Present.** `src/models/StripeWebhookEvent.js` with a unique index on `eventId`. The
handler (`walletController.js:429-439`) inserts the event id *first*; on duplicate-key
(`err.code === 11000`) it returns `200 {received:true, alreadyProcessed:true}` as a no-op,
so a Stripe retry cannot double-credit.

A **second, independent** idempotency layer exists at the transaction level:
`recordTransaction` short-circuits on an existing `stripeSessionId`
(`walletService.js:105-113`).

---

## 3. Frontend surface

### 3.1 Redux slices

**One slice, no duplicate.** `services/wallet/walletSlice.ts` is the only wallet slice;
it is registered in `store/store.ts:246` (`wallet: walletSlice.reducer`, imported `:66`).
`screens/user/wallet/` contains **only** screens (`WalletScreen.tsx`,
`TopUpWebViewScreen.tsx`, `TransactionHistoryScreen.tsx`) — no orphaned slice.
The duplicate the brief anticipated **has already been deleted** in W2 (`5309547`).

### 3.2 `networks/wallet/walletApi.ts`

Uses the **shared** axios instance: `import { API, API_URL } from "../network/network"`.
Its own header comment documents the migration off a private instance (it was previously
the fourth base-URL/interceptor set in the app). Base URL is
`WALLET_API_URL = ${API_URL}/wallet`, derived from the shared config. ✅ Prompt 4.2 satisfied.

### 3.3 Screens showing balance or wallet actions

| Surface | File | Reads |
|---|---|---|
| Wallet screen (role-aware) | `screens/user/wallet/WalletScreen.tsx` | `wallet` slice |
| Top-up return | `screens/user/wallet/TopUpWebViewScreen.tsx` | `wallet` slice |
| Transaction history | `screens/user/wallet/TransactionHistoryScreen.tsx` | `wallet` slice |
| MiniWalletCard (component) | `components/MiniWalletCard/MiniWalletCard.tsx` | `wallet` slice |
| User home / sidebar | `components/SlideOutSidebar/SlideOutSidebar.tsx:340` | nav → WalletScreen |
| Shopping home | `screens/Shopping/User/ShoppingHome/ShoppingHomeScreen.tsx:332` | MiniWalletCard |
| Healthcare home | `screens/user/healthcare/home/healthcareHome.tsx:549` | MiniWalletCard |
| Home-services home | `screens/user/homeservice/tabs/home-screen/index.tsx:248` | MiniWalletCard |
| Vendor dashboard | `screens/Shopping/Brand/BrandHome/BrandHomeScreen.tsx:119` | MiniWalletCard |
| Doctor dashboard | `screens/providers/healthcare/doctor-home/doctorHome.tsx:273` | MiniWalletCard |
| HS-provider dashboard | `screens/providers/homeservice/tabs/dashboard/dashboard.tsx:507` | MiniWalletCard |
| Shopping checkout payment | `screens/Shopping/User/CheckoutPayment/CheckoutPaymentScreen.tsx:188` | wallet slice + top-up link |
| Healthcare appointment payment | `screens/user/healthcare/AppointmentPayment/AppointmentPaymentScreen.tsx:157` | wallet slice + top-up link |
| Home-services payment | `screens/user/homeservice/payment-screen/payment.tsx:305,700` | wallet slice + top-up link |
| User profile | `screens/user/shared/profile/UserProfileScreen.tsx:218` | nav → WalletScreen |
| HS-provider profile | `screens/providers/homeservice/profile-screen/profile.tsx:312` | nav → WalletScreen |

**Every one reads the single `wallet` slice via `MiniWalletCard` or a direct selector.**

### 3.4 Reachability

`WalletScreen` is registered in the **root/base route map**
(`navigation-maps/Base.tsx:55` import, `:153` route name, `:629`, `:653`, `:661` component
registrations — including `UserWalletScreen` and `ProviderWalletScreen` aliases at `:255`/`:257`).
`DoctorStack.tsx:28-29` documents that it inherits the shared route rather than
re-registering its own. So the wallet is reachable from the user home, all three module
homes, and every provider dashboard — **not** DoctorStack-only. ✅ Prompt 4.3 satisfied.

### 3.5 Typecheck

`npx tsc --noEmit` → **clean, zero errors** (run 2026-07-26).

---

## 4. Defect list

### P0 — breaks top-up or corrupts money/stock

**Count: 0.**

Every P0 the brief anticipated has already been fixed and is verified above:

| Anticipated P0 | Status | Evidence |
|---|---|---|
| Webhook raw-body ordering | ✅ FIXED | `app.js:52` before `:59`; Buffer guard `walletController.js:407` |
| No webhook idempotency | ✅ FIXED | `StripeWebhookEvent` unique index; handler `:429-439` |
| Non-atomic read-modify-write balances | ✅ FIXED | `Wallet.creditAtomic`/`debitAtomic` with `$gte` guard, `Wallet.js:76-105` |
| Commission computed then discarded | ✅ FIXED | Platform ledger, `settle()`/`settlePayout()` |
| Dead `/webhook` route in walletRoutes | ✅ REMOVED | grep confirms absent |
| Duplicate frontend wallet slice | ✅ REMOVED | one slice, registered `store.ts:246` |
| Wallet-api private axios instance | ✅ FIXED | rides shared `API` |
| Wallet unreachable outside DoctorStack | ✅ FIXED | root registration `Base.tsx:629+` |

Backing tests: `stripeWebhook.test.js`, `walletConcurrency.test.js`, `walletSettle.test.js`
— **9/9 passing** (run 2026-07-26).

### P1 — wrong but not corrupting

**P1-1 — `payWithSettle()` is specified and documented but never implemented; payer legs
bypass the ledger service.**
*Files:* missing from `src/services/walletService.js`; referenced `:454`, `:619`.
Affected call sites: `shopping/services/checkoutService.js:182`,
`healthcare/services/paymentService.js:93`.
*Why it matters:* Prompt 2C requires every payment path to route through the service, and
Prompt 5 step 13 requires a clean "no balance mutation outside walletService" re-grep.
Today that grep returns 10 non-seed, non-admin hits. Not corrupting (the wrappers are
atomic), but it is the single largest gap between the shipped code and the spec.
*Fix location:* add `payWithSettle()` to `walletService.js`; convert the two payer legs and
the refund legs to it.

**P1-2 — module refund paths hand-roll credit + `recordTransaction`.**
*Files:* `shopping/services/orderService.js:133`, `healthcare/services/paymentService.js:142`,
`homeservice/controllers/adminController.js:192,301,316,404`, `walletController.js:800`.
*Why it matters:* same centralisation gap; each site must independently remember to write a
ledger row. They all do today — nothing enforces that they keep doing so.
*Fix location:* a `refund()` helper on `WalletService`, or route through `payWithSettle`'s
inverse.

**P1-3 — `settle()` sequential fallback has no compensating rollback.**
*File:* `walletService.js:590-596`. When no replica set is available, the three legs are
applied sequentially; a failure after the payer debit but before the payee credit throws to
the caller with the payer already debited. The comment acknowledges this and defers to the
caller. Home services (the only `settle()` consumer for a customer payment) does not
currently implement a compensating action.
*Note:* not reachable on a replica-set deployment; matters only on a standalone/free-tier
MongoDB.

### P2 — cosmetic / hygiene

**P2-1 — confusingly-named sibling smoke scripts.** `scripts/smoke-wallet.js` and
`scripts/wallet-smoke.js` differ by word order only, and the difference is not guessable
from the names. They are **not** duplicates — `smoke-wallet.js` (npm `smoke:wallet`) is a
direct-to-DB service-level check, while `wallet-smoke.js` (npm `smoke:wallet-stripe`) is
the Prompt 3 HTTP + signed-webhook end-to-end harness. Both are wired in `package.json`
and both are worth keeping; the names invite running the wrong one.
*Recommend:* rename to `smoke-wallet-service.js` / `smoke-wallet-stripe.js`. Non-blocking.

**P2-2 — stale doc references.** `walletService.js:454` and `:619` instruct the reader to
use `payWithSettle()`, which does not exist. Actively misleading to the next developer.
*(Resolved in Prompt 2 — the function now exists; see §7.)*

**P2-3 — `applyTopUp` new-vs-duplicate detection is timestamp-based.**
`walletService.js:171-172` infers "is this a new transaction" from
`Date.now() - createdAt < 1000`. It is belt-and-braces behind two real idempotency layers,
so it cannot cause a double-credit, but the heuristic is fragile and would be clearer as an
explicit flag returned by `recordTransaction`.

**P2-4 — `jest` binary lacks the exec bit** in this checkout; `npm test` fails with
`sh: 1: jest: Permission denied`. Workaround: `node node_modules/jest/bin/jest.js`.
Environmental, not a code defect.

---

## 5. Answers to the two questions the prompt asks for

> **P0 count:** **0.** All previously-anticipated P0s are fixed and test-covered.
> Remaining work is 3×P1 (centralisation, not corruption) and 4×P2.

> **Webhook line numbers:** `src/app.js` — raw mount at **lines 52–56**, global
> `express.json()` at **line 59**. The ordering is **correct**. The Buffer guard is at
> `src/controllers/walletController.js:407-412`; idempotency at `:429-439`.

---

## 6. What this means for the remaining prompts

- **Prompt 2** is ~90% already landed. The genuine remainder is **P1-1** (implement
  `payWithSettle()`, route the payer/refund legs through it) and **P1-2**.
- **Prompt 3** artifacts exist (`STRIPE_TESTING.md`, `.env.example`, `config/stripe.js`,
  `scripts/wallet-smoke.js`); needs a live run + the P2-1 duplicate cleaned up.
- **Prompt 4** is **done** — one slice, shared axios, root registration, 7 MiniWalletCard
  surfaces, tsc clean. No further work identified.
- **Prompt 5** cannot pass step 13 (`no orphan mutation`) until **P1-1/P1-2** are fixed.
  That is the gating item.

---

## 7. Post-audit addendum — what Prompt 2 then fixed

This section is appended after the audit was acted on, so the document does not read as
describing defects that no longer exist.

| Defect | Status | Change |
|---|---|---|
| **P1-1** `payWithSettle()` missing; payer legs bypass service | ✅ **FIXED** | Implemented `WalletService.payWithSettle()` (debit + ledger row as one unit, with credit-back rollback and `idempotencyKey` support). Shopping (`checkoutService.js`) and healthcare (`paymentService.js`) payer legs now call it. |
| **P1-2** refund paths hand-roll credit + record | ✅ **FIXED** | Added `WalletService.refund()`. Routed: shopping `orderService.refundToCustomer`, healthcare `refundAppointment`, home-service admin refund + dispute refund, and the Stripe payout-failure fallback in `walletController.js`. |
| **P2-2** stale `payWithSettle` doc refs | ✅ **FIXED** | The referenced function now exists. |
| — *(new, found while fixing)* checkout debited the customer then deleted the order on a later failure, never reversing the money | ✅ **FIXED** | The outer `catch` in `checkoutService.js` now reverses a completed wallet debit before deleting the group. |
| — *(new, found while fixing)* dispute penalty always recorded `status: 'completed'` because its guard `pWallet.balance >= 0` is always true | ✅ **FIXED** | Added `WalletService.debitOrDefer()`, which returns `collected` and records `pending` when the provider cannot cover the penalty. |
| **P1-3** `settle()` sequential-fallback has no compensating rollback | ⚠️ **OPEN** | Unreachable on a replica-set deployment; see §4. Documented, not fixed. |
| **P2-1** confusing sibling script names | ⚠️ **OPEN** | Cosmetic, non-blocking. |
| **P2-3** timestamp-based new-txn heuristic in `applyTopUp` | ⚠️ **OPEN** | Behind two real idempotency layers; cannot double-credit. |
| **P2-4** `jest` missing exec bit | ⚠️ **OPEN** | Environmental. |

**Orphan-mutation re-grep after the fixes** (`\.credit\(|\.debit\(`, excluding tests and
the `Wallet.js` definitions): the only remaining hit outside `walletService.js` is
`src/modules/shopping/seed/brands.seed.js:485` — **seed data, not a runtime path**. Every
production balance mutation now goes through `WalletService`. Prompt 5 step 13 can pass.

Wallet suites after the refactor: **13/13 passing** across `stripeWebhook.test.js`,
`walletConcurrency.test.js`, `walletSettle.test.js`, `adminWallet.test.js`.
