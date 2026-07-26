# SHOPPING_TRIAGE.md — Module Map & Defect List

**Date:** 2026-07-27 · **Repos:** `MetroMatrix-Backend`, `Waleed-MetroMatrix`
**Scope:** shopping-Usama.md PROMPT 1 (read-mostly triage).
**Evidence:** `scripts/shopping-triage-probe.js` — **81 checks OK, 3 flagged**, run against a live
server with the real scraped Cougar + Outfitters seed.

> **Headline: the module is in far better shape than the pack assumes.**
> The pack was written expecting broken filters, dummy data everywhere, RBAC leaks and shadowed
> admin routes. Measured against the running system: filters and sorts work, RBAC is clean on all
> 18 enumerated combinations, cross-tenant isolation holds, and only one screen still touches
> dummy data (static promo banners). **P0 count: 0.**
>
> Two of the three flagged items turned out to be **bugs in my own probe**, not the product — see
> §6, which I've kept in deliberately so the count isn't quietly inflated.

---

## 1. Backend surface

`/api/shopping` (mounted `src/app.js`) → `src/modules/shopping/routes/index.js`, **84 routes**:

| Router | Mount | Guard | Routes |
|---|---|---|---|
| `catalogRoutes` | `/` | **public** | 9 — brands, categories, products, outlets |
| `cartRoutes` | `/` | `customer` | 11 — cart, coupon, wishlist |
| `orderRoutes` | `/` | `protect, userOnly` | 13 — checkout, orders, tracking, returns, addresses, reviews |
| `vendorRoutes` | `/vendor` | `protect, requireVendor` → `requireBrandOwner` | 31 |
| `adminShoppingRoutes` | `/admin` | `protect, requireShoppingAdmin` | 20 |

Both `vendorRoutes` and `adminShoppingRoutes` apply their guards **globally via `router.use()`**
rather than per-route. That is why the RBAC enumeration came back clean — there is no per-controller
guard to forget.

**Missing endpoints: none.** Every parameterised path the frontend calls
(`networks/shopping/*.ts`) resolves to a real route. **Unused endpoints:** the vendor
`categories` CRUD and `coupons` update are wired but lightly used by the UI — not defects.

## 2. Frontend surface

**49 screens.** Customer `screens/Shopping/User/` (23), vendor `screens/Shopping/Brand/` (15),
admin `screens/admin/Shopping/` (11). API layer: `networks/shopping/` — 9 modules on a shared
`ShoppingAxiosInstance` with `SHOPPING_API_URL` from `config/env.ts` (one API host).

**Dummy data:** `config/env.ts:17` → `USE_SHOPPING_DUMMY_DATA = false`. The only remaining import
is `SHOPPING_BANNERS` in `screens/Shopping/User/ShoppingHome/shoppingHomeSlice.ts:5` — static
promo artwork, not business data. (See D-4.)

## 3. Happy-path results

### Customer — end to end, working
brand list (both brands) → brand store by slug → categories → product list (30) → **every sort and
filter verified to change the result set** → search → product detail with variants → reviews → cart
(same variant increments to qty 2 on one line; both brands present) → coupon applies (`COUGAR15`,
discount 255) → expired coupon rejected with *"This coupon has expired"* → addresses → **wallet
checkout, 2 child orders, total 7,438** → my orders → order detail → tracking → empty-cart checkout
rejected cleanly → wishlist. **All OK.**

### Vendor — end to end, working
All 10 surfaces return 200 (dashboard, brand, products, categories, inventory, orders, returns,
coupons, reviews, analytics). **Order isolation: Cougar 14, Outfitters 15, overlap 0.**

**The critical isolation test — PASSES.** As Outfitters against Cougar resources:

| Attempt | Result |
|---|---|
| MODIFY Cougar product | **404** ✅ |
| DELETE Cougar product | **404** ✅ |
| READ Cougar order | **404** ✅ |
| MODIFY Cougar order status | **404** ✅ |
| MODIFY Cougar inventory | **400** — denied, but wrong status (D-1) |
| Cougar stock after the attempt | **unchanged** ✅ |

Enforcement is central, not per-controller: `requireBrandOwner` sets `req.brand`, and every vendor
query is scoped by `brandId` (e.g. `applyStockChange`, `vendorCatalogController.js:220`).

### Admin — end to end, working
Dashboard, brands, orders, outlets, analytics, settings all 200.

**RBAC enumeration — 18/18 correctly denied**, no spot-checking:

| Endpoint | customer | vendor | no token |
|---|---|---|---|
| `/dashboard` `/brands` `/orders` `/outlets` `/analytics` `/settings` | **403** | **403** | **401** |

## 4. Brand data correctness & stock sync *(explicitly requested)*

> "each brand data must reflect correctly, what stock is displayed on user view must be what each
> brand has, and if a brand adds or updates something it must reflect in the user view"

**All verified green:**

| Check | Result |
|---|---|
| Cougar vendor product list contains only Cougar | 30 products, **0 foreign** |
| Cougar customer listing contains only Cougar | 30 products, **0 foreign** |
| Outfitters vendor list contains only Outfitters | 30 products, **0 foreign** |
| Outfitters customer listing contains only Outfitters | 30 products, **0 foreign** |
| **Cougar: customer-visible stock == vendor inventory** | **112 variants compared, 0 mismatched** |
| **Outfitters: customer-visible stock == vendor inventory** | **114 variants compared, 0 mismatched** |
| **Vendor stock edit → customer view** | set 18 → **customer sees 18**, immediately |
| **Vendor price edit → customer view** | set 2,110 → **customer sees 2,110**, immediately |

**Why it holds structurally:** there is exactly one source of truth. Stock lives on
`Product.variants[].stockQuantity`; the vendor inventory endpoint and the public product endpoint
both read that same subdocument — the vendor view is a projection, not a copy. There is no separate
vendor-side stock table to drift. Writes go through `applyStockChange`, which is brand-scoped and
writes an `InventoryLog`. Reads are uncached, so a vendor edit is visible on the next customer
request with no invalidation step to get wrong.

**One caveat:** suspended/pending brands are correctly hidden from customers
(`catalogService.listProducts` filters to `status:'active'`), so "reflects in user view" is
deliberately conditional on brand status. That is correct behaviour, not drift.

## 5. Defect list

**P0 (blocks the happy path or corrupts money/stock): 0.**

### P1

**D-2 — Two shadowed legacy routes in `src/routes/adminRoutes.js` (dead code).**
```
line 148: PUT /users/:userId/activate     → activateUserEnhanced    (LIVE)
line 154: PUT /users/:id/activate         → activateUser            (DEAD — Express matches the first)
line 149: PUT /users/:userId/deactivate   → deactivateUserEnhanced  (LIVE)
line 153: PUT /users/:id/deactivate       → deactivateUser          (DEAD)
```
The comment on line 143 claims *"One canonical handler per operation now; the dead registrations are
gone"* — it is wrong; the `// Legacy routes` block is still there. The live `*Enhanced` handlers are
a strict superset (they accept a `reason` and return the updated state), so the legacy pair can be
deleted safely. *Note: the pack predicted this on `/providers`, where it was already fixed by
`864d49b`; it survives on `/users`.* **Fix in Prompt 4.**

**D-3 — Global rate limit is low for a mobile shopping app.**
`src/app.js` — 100 requests / 10 min per IP. Browsing one brand (30 products, each product detail a
separate call) plus images and cart operations exceeds that in a single session, and mobile users
behind carrier NAT **share an IP**, so one throttled user can throttle a whole cell. This is not
theoretical: it broke this very triage run until worked around. *Flagging for your decision rather
than changing production limits unilaterally.*

### P2

**D-1 — Cross-tenant inventory denial returns 400 instead of 404.**
`vendorCatalogController.js:250` — `applyStockChange` correctly scopes by `brandId`, so a foreign
variant is simply not found and returns `{ok:false, reason:'Variant … not found'}` → HTTP 400.
**No data leak; stock verified unchanged.** Only the status code is wrong (a cross-tenant reference
is "not found", not "bad request"). Fix in Prompt 3.

**D-4 — `SHOPPING_BANNERS` imported from `dummyData`.**
`screens/Shopping/User/ShoppingHome/shoppingHomeSlice.ts:5`. These are static promotional banner
images, not business data, and there is no banners endpoint to replace them with. Prompt 6 requires
"no shopping screen imports dummyData except behind a flag defaulting to false" — this is the one
exception. **Recommend keeping** (with a comment) rather than inventing a CMS endpoint; calling it
out so it is a decision, not an oversight.

## 6. Corrections to my own first probe run — recorded deliberately

The first probe reported **8 failures**. Five were wrong, and it matters that the count isn't
inflated:

| First reported | Reality |
|---|---|
| `price_asc / price_desc / newest / rating` sorts are no-ops | **Working.** The probe sent `?sort=`; the API takes `?sortBy=` — which is exactly what `productApi.ts:28` sends. Re-tested: `price_asc` → 849, 949, 999…; `price_desc` → 2999, 2999, 2999… |
| `featured` filter is a no-op | **Working.** Param is `isFeatured`, not `featured`. Returns 4 products. |
| `popular` sort is a no-op | **Correct behaviour.** `popular` *is* the `default` case in `buildProductSort` (`catalogService.js:54-56`), so it matching the unsorted baseline is right. |
| Unknown coupon lacks a specific reason | **Acceptable.** *"Invalid coupon code"* is accurate and specific for a code that doesn't exist. Expired correctly returns *"This coupon has expired"*. |
| Vendor/admin logins failing | **Rate limiting**, not credentials — the auth limiter is 10/15 min and the probe logs in 4× per run. It now backs off and reports 429 explicitly instead of silently claiming "login failed". |

A probe that reports working code as broken is worse than no probe, because it sends you editing
healthy code. The script now uses the real parameter names and distinguishes throttling from failure.

## 7. Money & stock integrity — every write point

For Prompt 5 to verify independently.

**Stock writes**

| Location | Operation |
|---|---|
| `checkoutService.js:106-112` | decrement — atomic `$inc` with `stockQuantity: {$gte: qty}` guard |
| `checkoutService.js:236-241` | compensating restore if a later checkout step throws |
| `orderService.js:88` | `restoreStock` on **cancelled** |
| `orderService.js:113` | `restoreStock` on **refunded** *(added during the wallet work — returns previously never restocked)* |
| `vendorCatalogController.js:219-241` | `applyStockChange` — vendor manual set, brand-scoped, writes `InventoryLog` |

**Money writes** — all through `WalletService`, none direct:

| Location | Operation |
|---|---|
| `checkoutService.js:181` | `payWithSettle` — customer debit + ledger row, one unit |
| `checkoutService.js:208` | `refund` — reverses the debit if checkout fails after payment |
| `orderService.js:143` | `refund` — customer refund on cancel/return |
| `orderService.js:168` | `settlePayout` — vendor earning minus commission, commission → Platform, **on delivery** |
| `orderService.js:192` | `reversePayout` — reverses vendor earning **and** commission on refund |

Money moves at two distinct lifecycle points by design: the customer pays at **checkout**, the
vendor earns at **delivery**. Verified end to end by `scripts/wallet-qa-gate.js` (34/34) — Prompt 5
will extend rather than duplicate that.

## 7b. PROMPT 2 — customer path: status

**Backend integrity gate (`scripts/shopping-customer-gate.js`): 22/22 PASS.**
Steps 8 and 10 in full, with real numbers — see the commit message and §7 for the write points.

| Customer defect | Status |
|---|---|
| Backend happy path (browse → cart → coupon → checkout → orders → tracking) | **Fixed / verified** — was already green, now covered by an assertion script |
| Rupee-exact multi-brand split | **Verified** — children 5,633 == group 5,633, discount 405 == 405, shipping 150 == 150 |
| Stock decrement per variant | **Verified** — 11→9 (ordered 2), 24→23 (ordered 1) |
| Money conservation | **Verified** — debit 5,633 == 2,199 + 2,871 + 563 commission |
| Cart cleared, coupon `usedCount` incremented | **Verified** — 0 items remain; 2 → 3 |
| Negative cases (empty cart, out-of-stock-after-add, insufficient balance) | **Verified** — all blocked, no partial debit, no stock change |
| **C-1** BrandStore never rendered `error` — a failed load left a blank screen | **Fixed** |
| **C-2** BrandStore cart badge hardcoded `cartItemCount = 0` | **Fixed** — now reads `selectCartItemCount` |
| **C-3** ProductSearch showed *"No results found"* on a failed request | **Fixed** — error is now distinguishable from no matches |
| **C-4** ProductReviews rendered an empty list on failure, implying "no reviews" | **Fixed** |
| **C-5** ProductList showed *"No products found"* on a failed fetch | **Fixed** |
| **C-6** Cart claimed *"Your cart is empty"* while loading **and** on failure | **Fixed** — the most alarming of the set; a shopper reads it as "I lost my items" |

New shared component `components/Shopping/ScreenState.tsx` (LoadingState / ErrorState /
EmptyState) matching the idiom of the screens that already did this well.

**Still open (not blocking a demo):** `AddressSelection`, `CheckoutAddress`, `CheckoutPayment`,
`CheckoutReview` show errors but have no retry affordance; `CheckoutDelivery`, `PaymentSelection`,
`OrderConfirmation`, `ReturnRequest`, `WriteReview` have no error branch. These are
selection/form screens operating on already-loaded data, so a failure is far less likely to
strand the user — deferred to Prompt 6 polish rather than expanded here.

**`ShopColors` is redefined locally in 20 shopping screens** — flagged for Prompt 6, not touched
here (it is a refactor, not a bug fix).

## 8. Recommended plan for the remaining prompts

Given P0 = 0, the pack's "cut vendor or admin scope" contingency is **not needed**.

- **Prompt 2 (customer):** already end-to-end green. Remaining work is the *frontend* half the probe
  can't see — loading/error/empty states, tsc.
- **Prompt 3 (vendor):** fix **D-1**; hand-verify analytics against the DB; verify the full
  lifecycle + illegal-transition rejection and the return→stock→refund loop.
- **Prompt 4 (admin):** delete the **D-2** dead routes; trace brand suspend→hidden→reactivate; verify
  each setting actually changes live behaviour (the pack's "a setting nothing reads is a P0 trap").
- **Prompt 5:** `scripts/shopping-integrity.js` — oversell, split, conservation, refund, double-pay,
  reconciliation, stock conservation.
- **Prompt 6:** polish + `SHOPPING_DONE.md`.
