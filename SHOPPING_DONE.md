# SHOPPING_DONE.md — Shopping Module Production Readiness

**Date:** 2026-07-27 · **Repos:** `MetroMatrix-Backend`, `Waleed-MetroMatrix`
**Basis:** `SHOPPING_TRIAGE.md` (Prompt 1) → Prompts 2–5 → this sign-off.

## Result: **105 automated checks across four gates, 0 failures.**

| Gate | Script | Result |
|---|---|---|
| Customer path + integrity | `scripts/shopping-customer-gate.js` | **22 / 22** |
| Vendor path + isolation | `scripts/shopping-vendor-gate.js` | **40 / 40** |
| Admin path + RBAC | `scripts/shopping-admin-gate.js` | **23 / 23** |
| Money & stock integrity | `scripts/shopping-integrity.js` | **20 / 20** |
| Backend unit/integration suite | `npx jest` | **206 / 206** |
| Frontend typecheck | `npx tsc --noEmit` | **clean** |

---

## 1. The four checks that decide "actually done"

The pack names four. All pass, verified against the database.

| Check | Evidence |
|---|---|
| **Multi-brand checkout splits to the exact rupee** | children `6038` == group `6038`, difference **0**; discount and shipping apportionment reconcile exactly |
| **Two customers can't oversell the last unit** | exactly 1 of 2 simultaneous checkouts succeeds; loser gets a clean 400 (*"not enough stock"*); final stock **0**, never negative |
| **Reconciliation nets to zero across the seed** | every wallet balance == the net of its own completed ledger rows: **difference 0 across 77 wallets**; and a full sweep adds **zero** new drift (delta 0) |
| **Outfitters vendor gets 403/404 on a Cougar order** | **404**, in *both* directions, on product read/modify/delete, order read/modify, and inventory — with the target's stock verified unchanged |

---

## 2. The three role paths

### Customer — PASS
Brand list (both brands) → brand store → categories → **every filter and sort verified to change the
result set** → search → product detail with variants → reviews → cart (same variant increments to one
line; both brands present) → coupon applies, expired coupon rejected with *"This coupon has expired"*
→ addresses → **wallet checkout** → orders → detail → tracking.

**Integrity gate, with real numbers:**
```
group:      subtotal 5888  discount 405  shipping 150  TOTAL 5633
Cougar    : subtotal 2698  discount 405  shipping 150  total 2443
Outfitters: subtotal 3190  discount   0  shipping   0  total 3190
children:   subtotal 5888  discount 405  shipping 150  TOTAL 5633   ← difference 0

stock   A 11 → 9 (ordered 2) · B 24 → 23 (ordered 1)
money   customer −5,633 == Cougar +2,199 + Outfitters +2,871 + Platform +563
cart    cleared · coupon usedCount 2 → 3
```
**Negative cases:** empty cart, item that went out of stock *after* being added, and insufficient
balance — all blocked with **no partial debit and no stock change**.

### Vendor — PASS
Dashboard, brand profile, products, categories, inventory, orders, returns, coupons, reviews,
analytics. Product validation rejects missing fields, negative price and `salePrice > basePrice`.
Inventory updates persist exactly and write an `InventoryLog`.

Full lifecycle `pending → confirmed → processing → shipped (tracking) → out_for_delivery →
delivered`; `pending → delivered` correctly rejected. Earnings credit on delivery minus commission
into the **shared polymorphic wallet** (`ownerType: Provider`), visible on `/wallet/me` — not a
shopping-only balance. Return loop restores stock, refunds the customer, reverses the vendor
earning **and** the commission.

**Analytics hand-verified against the DB** (not trusted): revenue 14,198 · orders 19 · AOV 2,567 ·
returnsCount 5 · refundsAmount 9,544 · deliveryRate 45.5% · products 30 — all exact.

### Admin — PASS
**RBAC enumerated, not spot-checked:** 22 admin routes × 3 identities (customer, vendor, no token)
= **66 checks, zero leaks**, no 200s and no 500s.

**Brand suspend trace:** suspend → brand vanishes from the customer brand list, products **30 → 0**
in browsing, **0 leaked into search**, existing orders intact (19 → 19) and still admin-viewable →
reactivate → **0 → 30** restored.

Forced transitions require a reason (*"A reason is mandatory for admin status changes"*) and record
`actor=admin` in `statusHistory`. **Every setting proven to change live behaviour** — see §3.

---

## 3. Defects found and fixed

| ID | Severity | Defect | Status |
|---|---|---|---|
| **D-5** | P1 | **`defaultReturnDays` was a setting nothing read.** Editable in the admin settings screen, consumed by nothing — the return window used `brand.policies.returnDays` with a **hardcoded fallback of 7**. Changing the platform return window silently did nothing. This is exactly the pack's "P0 trap". | **FIXED** — brand policy still wins; the fallback is now the platform setting |
| **D-2** | P1 | **Two shadowed dead routes.** `PUT /users/:id/activate` and `/deactivate` were unreachable (Express matches `/users/:userId/…` first), sitting under a comment claiming they had already been removed. | **FIXED** — registrations, imports and 58 lines of orphaned handlers removed; detector: 44 routes, **0 shadowed** |
| **C-6** | P1 | **Cart claimed "Your cart is empty" while loading and on failure.** For a shopping cart this is the worst possible false claim — it reads as "you lost your items". | **FIXED** |
| **C-3/4/5** | P1 | ProductList/ProductSearch/ProductReviews each turned a failed request into a confident false claim: *"No products found"*, *"No results found"*, and an empty review list. A network error was indistinguishable from genuinely having nothing. | **FIXED** |
| **C-1** | P1 | BrandStore never rendered the `error` its slice had always tracked — a failed load was a blank screen with no explanation and no way out. | **FIXED** |
| **C-2** | P2 | BrandStore's cart badge was hardcoded `= 0` behind a *"will be wired to cart slice later"* comment. | **FIXED** |
| **D-1** | P2 | Cross-tenant inventory writes returned 400 instead of 404 (denial was always real; only the status was misleading). | **FIXED** |
| **P6-1** | P2 | BrandList had no back control despite being a drill-in screen, and was imported into the tab navigator without being registered. | **FIXED** |
| **P6-2** | P2 | A 30s timeout surfaced raw axios text (*"timeout of 30000ms exceeded"*, *"Network Error"*). | **FIXED** — readable, actionable messages |

**P0 count at triage: 0.** The module was in materially better shape than the pack assumed.

---

## 4. Prompt 6 checklist

| Requirement | Status |
|---|---|
| Zero live `USE_SHOPPING_DUMMY_DATA` branches | ✅ flag is `false` in `config/env.ts:17` |
| No shopping screen imports `dummyData` | ⚠️ **one exception** — `SHOPPING_BANNERS` in `shoppingHomeSlice.ts` (see §5) |
| Loading / error-with-retry / empty states | ✅ on all data-fetching browse+buy screens (see §5 for what remains) |
| Back control on non-root screens | ✅ BrandList fixed; OrderConfirmation deliberately has none (post-purchase, offers two forward actions instead) |
| No `console.log` / TODO / lorem ipsum | ✅ zero in `networks/shopping/` and all shopping screens |
| Two-per-row grid at computed size | ✅ `useProductGridSizing` on ProductList, BrandStore, ProductSearch, Wishlist, ShoppingHome |
| `cdn.shopify.com` images with fallback | ✅ `ProductCard` has `onError` → placeholder |
| Graceful failure, readable 30s timeout | ✅ fixed in `extractShoppingError` |
| `npx tsc --noEmit` clean | ✅ |
| Backend tests pass | ✅ 206/206 |

---

## 5. Still open — none of it blocks a demo

| Item | Why it is not blocking |
|---|---|
| **`SHOPPING_BANNERS` from `dummyData`** | Static promotional artwork, not business data, and there is no banners endpoint to replace it with. **Recommend keeping** rather than inventing a CMS endpoint — flagged so it is a decision, not an oversight. |
| **Checkout/form screens lack retry** (`CheckoutAddress`, `CheckoutPayment`, `CheckoutReview`, `AddressSelection`) — and `CheckoutDelivery`, `PaymentSelection`, `OrderConfirmation`, `ReturnRequest`, `WriteReview` have no error branch | These act on already-loaded data, so a failure is far less likely to strand the user. The screens where a failure produced a *false claim* were the priority and are all fixed. |
| **`ShopColors` redefined in ~20 screens** | Duplication, not a defect. A refactor, deliberately not bundled into a bug-fix pass. |
| **Global rate limit: 100 req / 10 min per IP** | Browsing one brand's 30 products exceeds this in a single session, and carrier-NAT mobile users **share an IP**. It broke the QA sweeps until worked around. **Flagged for your decision** rather than changed unilaterally — this is the one item I would look at before real users arrive. |
| **`avgOrderValue` vs `totalRevenue` use different bases** | AOV averages *all* orders; revenue counts *delivered* only. Both correct and self-consistent, but `revenue / orders ≠ AOV`, which may confuse a viewer. |

---

## 6. Reproduce from scratch

```bash
# ── backend ──────────────────────────────────────────────
cd MetroMatrix-NodeBackend/MetroMatrix-Backend
node scripts/seed-accounts.js
node scripts/seed-shopping.js          # Cougar + Outfitters, real scraped catalogue

# DISABLE_RATE_LIMIT is non-production only and is ignored when
# NODE_ENV=production — it exists so a full multi-role sweep isn't throttled.
DISABLE_RATE_LIMIT=true node src/server.js

# the four gates
API_URL=http://localhost:5000 node scripts/shopping-customer-gate.js   # 22/22
API_URL=http://localhost:5000 node scripts/shopping-vendor-gate.js     # 40/40
API_URL=http://localhost:5000 node scripts/shopping-admin-gate.js      # 23/23
API_URL=http://localhost:5000 node scripts/shopping-integrity.js       # 20/20

node node_modules/jest/bin/jest.js --runInBand                          # 206/206
# (npm test fails with "jest: Permission denied" in this checkout)

# if reconciliation shows residue from earlier QA runs (inserts ledger
# rows only — never changes a balance; idempotent)
node scripts/wallet-reconcile-repair.js --dry
node scripts/wallet-reconcile-repair.js

# ── frontend ─────────────────────────────────────────────
cd MetroMatrix/Waleed-MetroMatrix
npx tsc --noEmit
```

### Log in as each role

| Role | Email | Password | Route |
|---|---|---|---|
| Customer | `shopper1.qa@metromatrix.pk` | `Shopper@123` | `/api/auth/login` |
| Vendor (Cougar) | `vendor.cougar@metromatrix.pk` | `Vendor@123` | `/api/auth/provider/login` |
| Vendor (Outfitters) | `vendor.outfitters@metromatrix.pk` | `Vendor@123` | `/api/auth/provider/login` |
| Admin | `waleedhassansfd@gmail.com` | `Waleed@104` | `/api/admin/auth/login` |

> Providers use `/api/auth/provider/login`, **not** `/api/auth/login`. The wrong route returns
> "Invalid email or password" with correct credentials — the most common false bug report here.

**Customer entry flow:** shopping service → `ShoppingStack` (initial route **BrandList**) → pick a
brand → brand store tabs. BrandList is deliberately **not** a tab.

---

## 7. Honest notes

- **Brand data and stock parity were verified, not assumed.** 226 variants compared across both
  brands with **zero** mismatches between vendor inventory and customer-visible stock, and vendor
  stock/price edits appear on the customer side immediately. This holds structurally: stock has one
  source of truth (`Product.variants[].stockQuantity`) that both views read — there is no second
  table to drift and no cache to invalidate wrongly.
- **My own tooling was wrong twice, and it is recorded.** The first triage probe reported 8 failures;
  5 were probe bugs (wrong query param names — `sort` vs `sortBy`, `featured` vs `isFeatured` — and
  rate limiting misread as bad credentials). The first vendor gate passed every analytics check
  vacuously as "not exposed" because it looked for flat keys that live under `summary`. Both are
  written up in `SHOPPING_TRIAGE.md` §6 and §7c rather than quietly dropped — an inflated defect
  count would have sent the following prompts editing healthy code.
- **Reconciliation is reported as two separate questions** because conflating them would be
  misleading: whether the *code* drifts (delta across a full sweep — **0**), and whether the shared
  dev *database* currently reconciles in absolute terms (**0**, after clearing residue left by seed
  purges and by QA scripts that deliberately drain and restore balances).
