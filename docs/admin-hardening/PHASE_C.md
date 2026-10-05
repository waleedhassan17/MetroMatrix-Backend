# Phase C — no commission, provider analytics, console UI

Three requests from the product owner after the hardening phases:

1. There is no platform commission. Providers keep 100 % of what customers pay.
2. Tapping any provider anywhere in the admin console opens that provider's details and analytics. This covers home-service providers, doctors and vendors.
3. The core console screens get a UI/UX pass with real charts.

Branch `admin-hardening` in both repos. Nothing is pushed.

## C1 — Commission removed (money, not only the display)

| Area | Before | After |
|---|---|---|
| Settings | `commissionPercent` (default 10) in each of `AdminSettings.shopping/healthcare/homeservice` and in the module settings services | Removed. A stored value is dropped on read. The home-services PATCH refuses the field (400 `VALIDATION_FAILED`). Healthcare and shopping ignore unknown keys, as they did before. |
| Home-service wallet payment | `settle(…, commissionRate)`: the provider received 90 % and the Platform wallet 10 % | The provider receives the full amount. |
| Home-service cash payment | The provider's wallet was debited the commission, or a PENDING commission debit was recorded that reduced what they could withdraw | Nothing moves. The booking is marked paid. |
| Doctor payout / vendor payout | `settlePayout(…, commissionRate)`: fee or order total minus commission | The full fee or order total. `payout.commission` / `vendorPayout.commission` is now 0 (historical values are kept). |
| Provider earnings and dashboard; vendor analytics | "Net of commission" | Full amounts (vendor net profit = income − refunds) |
| Admin analytics | HS `commission`, shopping `commission` | Removed |
| Reconciliation | `platformCommissionBalance` | `platformWalletBalance` (the Platform wallet still holds commission taken before Oct 2026) |
| Provider app | "After platform fee (10%)" and price × 0.9 on a job | The full price ("You keep the full amount"). Old wallet lines read "Platform fee (before Oct 2026)". |

`walletService.settle/settlePayout` keep a `commissionRate` parameter, defaulting to 0, so `reversePayout` can still claw back commission recorded on old payouts. No caller passes a rate.

Migration `06-remove-commission` does two things:

- it unsets the three stored settings;
- it waives cash commissions still pending on provider wallets. Each one is set to status `failed` with `metadata.waived`, and gets one `AdminAuditLog` row (`wallet.commission.waive`, source `migration:06`).

It is idempotent and has a `--dry` mode. It is listed in `RELEASE_CHECKLIST.md`.

## C2 — Provider details and analytics

`GET /api/admin/providers/:providerId/analytics?range=30d|90d|12m` (guard: `canApproveProviders`, the same as provider detail) is implemented in `services/admin/providerAnalytics.js`. It returns one shape for every provider type:

- **summary**: `Metric[]` with period `range`, and a delta against the previous range of the same length;
- **series**: zero-filled Pakistan days (30d, 90d) or months (12m), each with `count` and `amount`;
- **breakdowns**, **recent** work, **wallet** (balance, wallet earnings, pending payouts) and **links**.

What each provider type contributes:

| Type | Summary | Breakdowns | Recent |
|---|---|---|---|
| Home service | jobs, paid, completed, cancelled or declined, completion rate, on-time rate, repeat customers, rating, average job length | by status, by service, ratings 5→1 | bookings |
| Doctor | appointments, paid fees, completed, cancelled, upcoming, rating, clinics | by status, by type | appointments |
| Vendor (every brand they own) | orders, delivered value, delivered, returned, average order, products | by status, top products | orders |

A provider with no doctor profile or brand gets an empty summary rather than invented zeros. Provider detail also returns availability, last login, the booking counters and links (`doctorId`, `brands`).

`providerId` is now included wherever a provider appears:

- queue and notification targets (doctor, brand, payout);
- disputes (`providerId`, `customerId`);
- platform leaderboards;
- healthcare revenue by doctor;
- shopping revenue by brand (`ownerId`);
- admin order detail (`brandOwnerId`).

In the app, `screens/admin/people/openProvider.ts` is the single way to open a provider, and every provider mention uses it:

- **Home services:** booking detail, payouts, disputes, busiest providers.
- **Healthcare:** doctor cards, appointments, appointment detail, clinics, reviews, top doctors.
- **Shopping:** brand owners, revenue by brand, order detail.
- **Platform:** the Leaders tab.
- **Queue:** a long press on doctor, brand and payout work.

The redesigned provider screen has a header with quick actions (call, email, their bookings or brand) and three tabs: Analytics · Profile · Activity. Decisions stay in the footer, and Delete moves to a "…" menu.

## C3 — Console UI

Kit changes:

- `KpiTile`: icon, plus a ▲/▼ trend chip coloured by whether the change is good;
- new `TrendChart`: columns or a line, clean ticks, press-and-drag readout, and a one-sentence screen-reader summary;
- `EntityRow`: trailing badge, tinted icon, urgency edge, long-press;
- `Section`: count and "See all";
- `BarList`: tappable rows and "Show all";
- `QueryState`: skeleton shapes;
- `StatusTimeline`: an icon per action;
- `AdminScreen`: labelled header actions and a summary strip.

Screen changes:

- **Overview:** summary strip, queue icons and wait colours (a day is a warning, three days are overdue, said in words too), trend chips, and module shortcuts.
- **Queue:** fixed the filter reset. A type passed in applies once, then the param is cleared. Also adds icons and wait colours.
- **People:** "Admins" icon, ratings on provider rows, "Active …" on customers.
- **Modules:** cards with a live figure.
- **Booking detail:** tappable people, a payment badge, and actions in the footer.
- **Home-services analytics:** a bookings-per-day chart instead of 90 text rows.
- **Platform analytics:** now on `AdminScreen`, with a working pull-to-refresh and `formatMoney` instead of "Rs.".

The old healthcare and shopping screens were not redesigned, as agreed. They only got the provider links and the commission removal.

## Evidence

- **Backend** `npm test`: 87 of 89 suites and 947 of 955 tests pass. The 2 failing suites (8 tests) are the ML suites. They fail because `@tensorflow/*` is not installed: the `main` merge at `06a63162` added those packages and `npm install` has not been run since. Nothing in this phase touches them.
  - Rewritten payment tests: HS `payment`, healthcare `payment`/`payout`, shopping `payout` (provider paid in full, no rate passed).
  - `adminSettings` (commission refused, legacy value never returned).
  - `adminMigrations` (06: dry run, unset, waive only pending commission debits, audit row, idempotent).
  - `adminProviderAnalytics` (7 tests, all contract-checked): each provider type, ranges, empty provider, 400/403/404, `providerId` on queue and notification targets.
- **Lint:** unchanged from baseline (133 problems; the 4 errors are the missing optional modules).
- **Routes:** `dump-routes --check` up to date.
- **App:** `tsc` clean; jest passes 31 suites / 335 tests (1 suite skipped); design gates pass; no-static-data passes; `sync-admin-spec --check` passes; `grep -ri commission screens/admin networks/admin` finds nothing outside the generated spec. New tests: `openProvider`, `queueLook`, `days`, `trendChart`, and the extended `metrics` test.
- **E2E** (`e2e/adminConsole.e2e.test.ts` against `npm run dev:memory`, `JWT_EXPIRE=1m`): 13 of 13 pass. That includes A1 (no commission setting; sending one gets 400) and A2 (analytics for the seeded home-service provider, doctor and vendor, with full amounts: 2,500 / 2,000 / 3,750). The dev seed now has an approved doctor and vendor.

Still needs a person with a device: tapping through the provider links on a phone, and checking the charts in dark mode and with a screen reader (open item 18).
