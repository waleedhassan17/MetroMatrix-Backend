# HOMESERVICE_API — Home Services Endpoint Reference

All endpoints are mounted at `/api` (see `src/app.js`, `src/modules/homeservice/routes/{index,adminRoutes}.js`).
Auth: `Authorization: Bearer <accessToken>` unless marked **public**. Response envelope is always
`{ success: boolean, data, message?, pagination? }`. Real-time events are documented separately in `SOCKET_API.md`.

Canonical booking status: `PENDING → ACCEPTED|REJECTED|CANCELLED → EN_ROUTE → ARRIVED → IN_PROGRESS → COMPLETED`
(see `src/modules/homeservice/services/statusMap.js`).

---

## Customer endpoints

| Method | Path | Body / Params | Response | Errors |
|---|---|---|---|---|
| GET | `/providers?category&lat&lng&maxDistanceKm&minRating&maxPrice&available&search&sort&page&limit` | query (**public**, `optionalAuth`). `sort` = `best` (default) \| `nearest` \| `rating` \| `reviews` \| `price_low` \| `price_high`; `available=true` = *available now* (online, seen in the last `onlineStaleMinutes`, inside today's working hours, PKT) | `{ providers: Provider[] (+distanceKm, distanceApprox, etaMinutes, availableNow, matchingScore, scoreBreakdown{distance,rating,availability,quality}, rankingSource), pagination, searchArea{nearYou,radiusKm,widened}, sort, searchId }` — `$geoNear` on the `providers` 2dsphere index when a location is known, plain `$match` otherwise; cached 30 s per ~1 km cell | 200 always (empty list if none) |
| GET | `/providers/:providerId` | — | `ProviderDetails` | 404 not found |
| GET | `/providers/:providerId/reviews?page&limit` | query | paginated review list | — |
| GET | `/service-categories` | — **(public)** | `ServiceCategory[]` | — |
| GET | `/user/home` | — | `{ categories, promotions }` | 401 |
| GET | `/bookings/init/:providerId` | — | `{ provider, addresses, timeSlots }` | 404 provider not found |
| POST | `/bookings` | `{ providerId, selectedDate, selectedTime, addressId, instructions?, rankingContext?{searchId,position} }` (`rankingContext` credits the search that showed this provider — the matching model's training label) | `BookingConfirmation` | 400 no address, 404 provider |
| GET | `/bookings/:id` | — | full booking detail | 403 not a participant, 404 |
| GET | `/bookings/:id/service-status` | — | `ServiceStatus` | 403/404 |
| GET | `/bookings/:bookingId/tracking` | — | `TrackingData` (last known position) | 403/404 |
| PATCH | `/bookings/:id/status` | `{ status, reason? }` | `{ bookingId, status }` | 400 illegal transition |
| POST | `/bookings/:id/cancel` | `{ reason? }` | `{ success, bookingId }` | 400 not cancellable |
| POST | `/bookings/:id/dispute` | `{ reason, description?, evidence? }` (`evidence` = URLs from `POST /api/uploads/sign`, purpose `dispute_evidence`) | `{ disputeId, status }` | 400 open dispute exists / not your upload |
| POST | `/bookings/:id/verify-identity` | `{ token, method: 'nfc'\|'qr' }` or `{ code }` — the provider's doorstep ID read from their NFC badge, QR code or 6-digit code (`userOnly`) | `{ verified, method, verifiedAt, status }`; an `EN_ROUTE` booking becomes `ARRIVED` (no "arrived" push to the customer); provider gets push + room event `identity_verified` | 400 malformed, 409 wrong status / already used, 422 not genuine / expired / replaced / wrong code (*N tries left*), 429 fifth wrong code |
| GET | `/user/bookings?status` | query | `UserBooking[]` | 401 |
| POST | `/user/bookings/:bookingId/cancel` | — | `{ bookingId }` | 400/403 |
| PATCH | `/user/bookings/:bookingId/status` | `{ status }` | `{ bookingId, status }` | 400 illegal |
| POST | `/user/bookings/:bookingId/rate` | `{ rating, review? }` | `SubmittedReview` (bridges to `/reviews`) | 400 not completed/duplicate |
| GET | `/user/notifications` | — | `HSNotification[]` derived from statusHistory | 401 |
| GET | `/user/profile` | — | `UserProfileData` | 401 |
| PATCH | `/user/profile` | `Partial<UserProfile>` | `UserProfile` | 401 |
| POST | `/user/profile/avatar` | `{ avatar }` | `{ avatar }` | 401 |
| GET | `/user/addresses` | — | `UserAddress[]` | 401 |
| POST | `/user/addresses` | `{ label, address, city, isDefault?, coordinates? }` | `UserAddress` | 400 missing address |
| PATCH | `/user/addresses/:addressId` | partial | `UserAddress` | 404 |
| DELETE | `/user/addresses/:addressId` | — | `{ addressId }` | 404 |
| GET | `/chat/:bookingId` | — | `ChatData` (history) | 403/404 |
| POST | `/chat/:bookingId/messages` | `{ message }` | `ChatMessage` | 400 empty, 403/404 |
| GET | `/payments/:bookingId/init` | — | `PaymentData` (+ walletBalance) | 403/404 |
| POST | `/payments/process` | `{ bookingId, method, amount, tipAmount? }` | `Transaction` | 400 not completed / already paid / insufficient balance |
| GET | `/reviews/:bookingId/init` | — | `ReviewData` | 403/404 |
| POST | `/reviews` | `{ bookingId, providerId, rating, feedback, tags[] }` | `SubmittedReview` | 400 not completed / not customer / duplicate / bad rating |

## Provider endpoints

| Method | Path | Body / Params | Response | Errors |
|---|---|---|---|---|
| GET | `/provider/jobs?status&page&limit` | query (status = display bucket) | `{ jobs, stats, pagination }` | 401 |
| GET | `/provider/jobs/:jobId` | — | `JobDetail` | 403/404 |
| POST | `/provider/jobs/:jobId/accept` | — | `{ success, status }` | 400 illegal, 403 not assigned |
| POST | `/provider/jobs/:jobId/reject` | `{ reason? }` | `{ success, status }` | 400/403 |
| POST | `/provider/jobs/:jobId/start` | — | `{ success, status }` (→ EN_ROUTE) | 400/403 |
| POST | `/provider/jobs/:jobId/arrived` | — | `{ success, status }` | 400/403 |
| POST | `/provider/jobs/:jobId/start-work` | — | `{ startTime }` (→ IN_PROGRESS) | 400/403 |
| POST | `/provider/jobs/:jobId/complete-work` | — | `{ endTime, duration }` (→ COMPLETED) | 400/403 |
| POST | `/provider/jobs/:jobId/complete` | `{ finalAmount, notes?, photos? }` | `{ success }` | 400/403 |
| POST | `/provider/jobs/:jobId/finalize` | — | `{ completed }` | 400 not completed |
| GET | `/provider/jobs/:jobId/awaiting-approval` | — | `AwaitingApprovalData` | 403/404 |
| GET | `/provider/jobs/:jobId/approval-status` | — | `{ isApproved, approvalTime? }` | 403/404 |
| GET | `/provider/jobs/:jobId/in-progress` | — | `JobInProgressData` | 403/404 |
| GET | `/provider/jobs/:jobId/completion` | — | `JobCompletionData` | 403/404 |
| GET | `/provider/jobs/:jobId/navigation` | — | `NavigationParams` | 403/404 |
| GET | `/provider/jobs/:jobId/payment` | — | `PaymentInitData` | 403/404 |
| POST | `/provider/jobs/:jobId/request-payment` | `{ amount }` | `{ requestId }` | 400 not payable |
| POST | `/provider/jobs/:jobId/confirm-payment` | `{ transactionId }` | `{ confirmed }` | — |
| POST | `/provider/jobs/:jobId/confirm-cash` | — | `{ transactionId }` | 400 already paid |
| GET | `/provider/dashboard` | — | `DashboardData` | 401 |
| GET | `/provider/profile` | — | `ProviderDetails` | 401 |
| PATCH | `/provider/profile` | `{ name?, bio?, price?, city?, experience?, serviceRadius? }` | `Provider` | 401 |
| PATCH | `/provider/status` / `/provider/online-status` | `{ isOnline, base?: { lat, lng } }` — going online with a position samples the service base, unless the provider pinned one on purpose (and did not opt into `autoUpdateBaseOnOnline`) | `{ isOnline, serviceBase? }` | 401 |
| PUT | `/provider/location/base` | `{ lat, lng }` (inside Pakistan) — the coarse service base (~500 m grid) search measures distance from; the live track is never stored | `{ serviceBase: { latitude, longitude, source, updatedAt } }` | 400 bad / out-of-country coords |
| POST | `/provider/heartbeat` | — (every ~2 min while the app is open) | `{ recorded, nextInSeconds }` — keeps `availableNow` honest | 401 |
| POST | `/provider/jobs/:jobId/identity-token` | — (status `EN_ROUTE`/`ARRIVED`) | `{ token, code, nfcUri, qrPayload, expiresAt, ttlSeconds: 600 }` — HMAC-signed, booking-bound, single use; or `{ alreadyVerified, verifiedAt, method }` | 403 not assigned, 409 wrong status |
| GET | `/provider/earnings?period` | query | `EarningsData` (+ availableBalance, commissionPercent) | 401 |
| POST | `/provider/earnings/payout` / `/provider/payout-request` | `{ amount, method, accountDetails? }` | `{ payoutId, status }` | 400 below minimum / exceeds available balance |
| POST | `/provider/location` | `{ latitude, longitude, jobId? }` | `{ distance, duration }` | 400 bad coords |

## Admin endpoints (`/api/admin/*`, `protect + adminOnly`)

| Method | Path | Body / Params | Response | Errors |
|---|---|---|---|---|
| GET | `/admin/bookings?status&serviceCategory&provider&search&from&to&page&limit` | query | booking list | 403 non-admin |
| GET | `/admin/bookings/:id` | — | full detail + statusHistory + payment trail + dispute/review | 404 |
| PATCH | `/admin/bookings/:id/status` | `{ status, reason }` (reason **mandatory**) | `{ bookingId, status }` | 400 no reason, 400 illegal (force allowed) |
| POST | `/admin/bookings/:id/refund` | `{ amount?, reason }` (reason **mandatory**) | `{ refunded, amount, transactionId }` | 400 no reason/bad amount |
| GET | `/admin/disputes?status&page` | query | dispute list | — |
| PATCH | `/admin/disputes/:id` | `{ status, resolution?, refundAmount?, penalizeProvider?, reason? }` | `{ disputeId, status }` | 404 |
| GET | `/admin/payout-requests?status` | query | payout list (+ provider wallet balance) | — |
| PATCH | `/admin/payout-requests/:id` | `{ action: 'approve'\|'reject', reason? }` | `{ payoutId, status }` | 400 already decided / insufficient balance / no reason on reject |
| GET | `/admin/service-categories` | — | `ServiceCategory[]` | — |
| POST | `/admin/service-categories` | `{ name, slug, providerSubType, ... }` | created category | 400 missing fields |
| PATCH | `/admin/service-categories/:id` | partial | updated category | 404 |
| DELETE | `/admin/service-categories/:id` | — | `{ deleted }` | 404 |
| GET | `/admin/homeservice/dashboard` | — | tiles: pending approvals, bookings today, GMV today, open disputes, pending payouts, online providers | — |
| GET | `/admin/homeservice/analytics?from&to` | query | bookings over time/category/status, revenue, commission, avg completion time, cancellation rate, top providers | — |
| GET | `/admin/homeservice/settings` | — | commission%, cancellation window, radius, matching weights (`distance`, `rating`, `availability`, `quality`), `onlineStaleMinutes`, `ranking{mode: heuristic\|shadow\|blend\|model, blendAlpha, explorationBoost}`, min payout, avg speed | — |
| PATCH | `/admin/homeservice/settings` | partial | updated settings | — |

Every admin mutation above writes an `HSAuditLog` record: admin id, action, target, before/after, reason.

## Server-to-server (`x-internal-key: INTERNAL_API_KEY`)

| Method | Path | Called by | Does |
|---|---|---|---|
| GET\|POST | `/api/internal/scheduler/tick` | realtime dyno every 5 min; GitHub Actions watchdog every 15 min | appointment reminders (−1 h), video reminders (−5 min), booking reminders (−1 h), request expiry — each claimed atomically, so overlapping ticks never double-send |
| POST | `/api/internal/homeservice/bookings/:bookingId/nearby` | realtime, when a live position is ~5 min away | once-only `booking_nearby` push + `provider_nearby` room event (`notifications.nearbyAt` claim) |

## Discovery, matching and recommendations (cross-module, mounted at `/api`)

| Method | Path | Notes |
|---|---|---|
| GET | `/search/services?q&lat&lng` | "My AC is dripping, need someone today" → `{ interpreted{category,label,availableNow,candidates,source:'rules'\|'llm'}, providers[≤3], noneAvailableNow }`. Keyword rules (English + Roman-Urdu) first; Gemini (`GEMINI_API_KEY`) only for descriptions the rules cannot place; rate-limited (`nlq`) |
| GET | `/recommendations/homeservice?lat&lng` | `userOnly`. "Book again" (providers rated ≥4★) + top matches in the trades this customer books, through the same discovery pipeline as search; `{ source, items[{provider, reason}] }` |

The learned re-ranker (`src/modules/ml/services/rankingService.js`) re-orders the top 50 of a `sort=best` search when the admin ranking mode is `blend`/`model` and an active model passes its parity check; every search logs its impressions (`ml_search_impressions`) with the features used, and bookings are credited through `rankingContext.searchId`.

---

## Ownership & guards

- `protect` (JWT) on every route above except `/providers`, `/providers/:id`, `/providers/:id/reviews`, `/service-categories` (public reads).
- `userOnly` / `providerOnly` / `adminOnly` restrict role.
- `loadBookingWithAccess` (middleware) loads the booking with `customer`+`provider` populated and 403s anyone who is neither the customer, the assigned provider, nor an admin. This covers read access.
- The booking state machine (`bookingService.transition`) separately enforces WHO may make WHICH transition on top of that — only the ASSIGNED provider (not just any provider) may accept/reject/advance a job, and only the customer may cancel, and only before `IN_PROGRESS`.
