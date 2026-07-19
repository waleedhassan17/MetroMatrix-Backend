# MetroMatrix Shopping API

Base URL: `https://metro-matrix-backend.vercel.app/api/shopping` (production, Vercel)
Local: `http://localhost:5000/api/shopping`

## Envelopes

Every endpoint uses the frontend contract from `types/shopping.ts`:

```
List:   { "success": true, "data": [...], "pagination": { "page", "limit", "total", "pages" } }
Single: { "success": true, "data": {...} }
Error:  { "success": false, "error": "message", "errors?": [...] }   (4xx / 5xx)
```

## Roles

| Role | Token | Requirement |
|---|---|---|
| Public | none | browsing only |
| Customer | User JWT (`/api/auth/login`) | active account |
| Vendor | Provider JWT (`/api/auth/provider/login`) | `providerType=vendor`, `adminVerified=active`, owns a Brand |
| Admin | Admin JWT (`/api/admin/auth/login`) | `permissions.canManageShopping` or super admin |

## 1. Public catalogue

| Method | Path | Params | Returns | Errors |
|---|---|---|---|---|
| GET | `/brands` | `page,limit` | Paginated `BrandConfig` (active only) | — |
| GET | `/brands/:brandId` | — | `BrandConfig` | 400 bad id, 404 |
| GET | `/brands/slug/:slug` | — | `BrandConfig` | 404 |
| GET | `/brands/:brandId/categories` | — | `Category[]` (2-level tree with productCount) | 404 |
| GET | `/categories/:categoryId` | — | `Category` | 400, 404 |
| GET | `/products` | `brandId, categoryId, search, sortBy (price_asc\|price_desc\|rating\|newest\|popular), minPrice, maxPrice, inStock, isFeatured, isNewArrival, page, limit` | Paginated `Product` | 400 bad filter id |
| GET | `/products/:productId` | — | `Product` | 400, 404 (also 404 if brand suspended) |
| GET | `/products/:productId/reviews` | `page,limit` | Paginated `ProductReview` | 400 |
| GET | `/outlets` | `brandId, city, lat, lng, radiusKm, page, limit` | Paginated `OutletConfig` | 400 |
| GET | `/outlets/:outletId` | — | `OutletConfig` | 404 |

Suspended/pending brands and their products are invisible on all of the above.

## 2. Cart, coupons, wishlist (Customer)

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/cart` | — | lazily creates empty cart; totals always recomputed server-side |
| POST | `/cart/items` | `{ productId, variantId, quantity }` | 400 out-of-stock / inactive brand; same (product,variant) merges |
| PATCH | `/cart/items/:itemId` | `{ quantity }` | 400 stock, 404 |
| DELETE | `/cart/items/:itemId` | — | 404 |
| DELETE | `/cart` | — | clear |
| POST | `/cart/coupon` | `{ couponCode }` | 400 with user-facing reason (expired / limit / min order / wrong brand) |
| DELETE | `/cart/coupon` | — | |
| GET | `/coupons` | `?brandId` | currently usable coupons |
| GET | `/wishlist` | — | items include populated `product` card |
| POST | `/wishlist/:productId` | — | 404 |
| DELETE | `/wishlist/:productId` | — | |

Shipping rule: `shippingFeePerBrand` (PKR 150) per brand in cart, waived per brand at `freeShippingThreshold` (PKR 3000). Values come from admin settings — not constants.

## 3. Checkout & orders (Customer)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/checkout` | `{ addressId \| shippingAddress, paymentMethod: 'wallet'\|'cod' }` | 201 `OrderGroupView`; revalidates lines, recomputes totals, atomic stock guard, splits per brand, wallet debit; 400 insufficient balance / stock with per-line reasons |
| GET | `/orders` | `?status&page&limit` | my `OrderGroupView`s |
| GET | `/orders/:id` | — | accepts groupId or child orderId |
| GET | `/orders/:orderId/tracking` | — | statusHistory + trackingNumber (accepts groupId → first child) |
| POST | `/orders/:orderId/cancel` | `{ reason }` | only while pending/confirmed; restores stock; refunds wallet if paid |
| POST | `/orders/:orderId/return` | `{ items?, reason, images? }` | delivered only, within brand returnDays |
| GET | `/returns` | — | my return requests |
| GET/POST | `/addresses` | address fields | POST 400 on missing fullName/phone/addressLine1/city |
| PATCH/DELETE | `/addresses/:addressId` | — | 404 |
| POST | `/products/:productId/review` | `{ rating, title?, comment, images? }` | 403 without delivered purchase; one review per product per order; recomputes rating |

**Order state machine** (`orderService.ALLOWED_TRANSITIONS`):
pending → confirmed|cancelled; confirmed → processing|cancelled; processing → shipped|cancelled; shipped → out_for_delivery → delivered → returned → refunded. `cancelled`/`refunded` terminal.
Actors: vendor fulfils; customer cancels only pending/confirmed; admin force-transitions with audited reason. Illegal moves → 400.

**Payments:** wallet = debit at checkout (group + children `paid`); cod = paid at delivered. Vendor payout at delivered = order total − commission%. Refund credits customer wallet and reverses payout.

## 4. Vendor `/vendor/*` (all require vendor + brand ownership)

| Method | Path | Notes |
|---|---|---|
| POST | `/vendor/brand` | create profile (pending unless auto-approve) |
| GET / PATCH | `/vendor/brand` | my profile / theme / policies |
| POST | `/vendor/brand/logo` `/banner` | `{ image: base64 }` → Cloudinary |
| GET | `/vendor/products` | `?search&stockStatus(in|low|out)&page&limit` |
| POST / PATCH / DELETE | `/vendor/products[/:productId]` | delete = soft (isActive=false) |
| POST | `/vendor/products/:productId/images` | `{ images: [base64] }` |
| GET/POST/PATCH/DELETE | `/vendor/categories[/:categoryId]` | 2 levels max; delete blocked while products attached |
| GET | `/vendor/inventory` | per-variant rows + lowStock/outOfStock flags |
| PATCH | `/vendor/inventory/:variantId` | `{ stockQuantity, reason }` → InventoryLog |
| POST | `/vendor/inventory/bulk` | `{ updates: [...] }` |
| GET | `/vendor/orders[/:orderId]` | `?status`; my brand only |
| PATCH | `/vendor/orders/:orderId/status` | `{ status, note?, trackingNumber? }` via state machine |
| GET / PATCH | `/vendor/returns[/:returnId]` | flow requested→approved→picked_up→refunded (or rejected); refunded restores stock + wallet refund |
| GET/POST/PATCH | `/vendor/coupons[/:couponCode]` | my brand's coupons |
| GET | `/vendor/reviews` | `?rating`; POST `/vendor/reviews/:reviewId/respond` |
| GET | `/vendor/analytics` | `?period=7d\|30d\|90d\|all` — summary, revenueChart, topProducts, categoryBreakdown |
| GET | `/vendor/dashboard` | BrandHome KPIs, weeklySales, recentOrders, lowStockAlerts |

Cross-brand access (`:brandId` not yours or another brand's resources) → 403, enforced by `requireBrandOwner` middleware (tested).

## 5. Admin `/admin/*` (canManageShopping)

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/brands` | `?status&search`; includes owner info |
| GET | `/admin/brands/:brandId` | + productCount, orderCount, revenue |
| POST / PATCH / DELETE | `/admin/brands[/:brandId]` | delete = soft |
| PATCH | `/admin/brands/:brandId/status` | `{ status: active\|suspended\|pending, reason }` — suspend hides storefront instantly |
| CRUD | `/admin/outlets…` | + `assign-brand`, `color-scheme`, `toggle-status` |
| GET | `/admin/orders` | `?brandId&status&paymentStatus&from&to&search` |
| GET | `/admin/orders/:orderId` | full trail + sibling orders of the group |
| PATCH | `/admin/orders/:orderId/status` | force-transition; **reason mandatory** |
| POST | `/admin/orders/:orderId/refund` | manual wallet refund; **reason mandatory**; paid orders only |
| GET | `/admin/analytics` | `?from&to` — GMV series, revenueByBrand, commission, ordersByStatus, topProducts, returnRate |
| GET | `/admin/dashboard` | pendingBrandApprovals, ordersToday, gmvToday, openReturnRequests, lowStockAlerts |
| GET / PATCH | `/admin/settings` | commissionPercent, shippingFeePerBrand, freeShippingThreshold, lowStockThreshold, defaultReturnDays, autoApproveBrands — same values checkout/inventory read |

Every admin mutation writes `ShoppingAuditLog { admin, action, targetType, targetId, before, after, reason, at }`.

## Scripts

```
npm run seed:shopping    # idempotent multi-vendor demo dataset
node scripts/seed-accounts.js   # admin / vendor / demo customer logins
npm run smoke:shopping   # 14-step critical path (needs API_URL env or localhost:5000)
```

Demo logins: see seed script output (customer.demo@metromatrix.pk, vendor.*@metromatrix.pk, user1-3@metromatrix.pk).
