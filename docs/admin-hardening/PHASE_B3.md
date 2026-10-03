# Phase B3 — data correctness & contract (with the B5 quality gate)

Fixes BE-D1, BE-D2, BE-D3, BE-D4, BE-D6, BE-D7, BE-E (meta/overview/queue) and X2 on the server.

## What changed

| Area | Before | After |
|---|---|---|
| Envelope | 6+ shapes; `data` and `stats` side by side; 4 pagination formats | One envelope for all 132 admin operations (core, home services, healthcare, doctors, specialties, wallet, shopping admin); `meta: { page, limit, total, pages, nextCursor }` |
| Paging | `parseInt(limit) \|\| 10`, no ceiling; `limit=0` = everything; sort field straight from the query | Clamped 1–100, sort whitelist, cursor paging (`utils/pagination.js`) |
| Growth | "Last month" window had no end (included this month); baseline 0 → `0` (app turned it into +12 %); healthcare baseline 0 → +100 % | Asia/Karachi windows; month-to-date vs the same period last month; `null` without a baseline |
| "Today" | Server (UTC) midnight in every dashboard | Asia/Karachi day |
| Provider states | `adminVerified: inactive` counted as rejected (included suspended); pending included unsubmitted sign-ups | `verificationStatus` + `isSuspended` via a single writer (dual-writes the login flags); states incomplete / pending / approved / rejected / suspended |
| Module dashboards | Inline in controllers, not reusable; HS GMV ignored the requested amount; healthcare under-counted pending doctors; shopping loaded every product into memory | Services (`modules/*/services/adminDashboardService.js`) used by the module endpoints and `/overview` |
| Home screen | Registrations and posts only | `GET /overview`: work queues, KPIs with periods, one block per module (degrades to `unavailable`), recent activity — permission-filtered, `Cache-Control: private, max-age=30` |
| Work queue | None | `GET /queue`: provider/doctor/brand approvals, disputes, payouts, returns, pending wallet adjustments — oldest first, stable cursor, per-permission |
| Option lists | Hardcoded in the app | `GET /meta`: statuses read from the schemas with label + tone, roles, permissions, limits, specialties, categories, cities, feature flags |
| Notifications | Global read flag; delete for everyone; produced for 2 events (one misaddressed) | Per-admin read/dismiss, permission scoping, targets, dedupe; producers for submissions (provider, doctor, brand), disputes, payouts, returns, pending adjustments, reconciliation drift, failed Stripe events, new customers |
| Code layout | `adminController.js` 2,262 lines + `notificationController.js` | `controllers/admin/*` (largest: `auth.js`), public onboarding in `providerSubmissionController.js` |
| Contract | None | `docs/admin.openapi.yaml` (132 operations, x-guards, core schemas) + `adminContract.test.js` (drift both ways, responses validated) |
| Indexes | `email` declared twice on User/Provider/Admin → `createIndexes` failed | Duplicates removed; console indexes added |

B5 quality gate (continuous): `/health/ready`, start-up validation tests, forbidden-access matrix over every guarded route, `docs/DEPLOY.md`, `docs/RELEASE_CHECKLIST.md`, `scripts/audit-prod-hygiene.js`.

## Evidence

- `adminConsoleData.test.js` (20): windows incl. year boundary and month-end cap; growth null; meta; overview empty-DB zeros, failing module → `unavailable`, permission filtering, MTD-vs-same-period, **< 800 ms on 5k users / 1k providers / 5k bookings**; queue order + cursor + permission filter; suspend ≠ reject + sign-out flags; reasons required; pending = submitted only; `limit=100000` → 100, unknown sort ignored; cursor walk without repeats; per-admin notifications; dedupe; analytics daily series in PKT; one envelope across 16 endpoints.
- `adminContract.test.js` (6), `adminForbiddenMatrix.test.js` (3 — ~100 guarded routes × no-permission admin → 403; every admin route × customer token → 401/403), `healthAndConfig.test.js` (9), `adminMigrations.test.js` (8 — migrations 01–05 + hygiene script).
- Full suite: **58 suites / 682 tests pass**. Lint 0 errors / 114 warnings (baseline 123).

## Deviations from the plan

- Sentry was not added: it needs an account/DSN (owner). Logs + request ids + `/health/ready` cover the gap; tracked in open items.
- `sync-indexes.js` already loaded the module models; no change was needed.
- The public provider-submission endpoint was moved out of the admin controller but its auth was **not** changed (it identifies the provider by the email in the body; the app strips the token). Changing it needs a provider-app change — logged as a High open item.

## New risks

- Breaking for the old admin app (envelope, removed duplicate endpoints — see the change table in `ADMIN_API_GUIDE.md`). Ships with the F-phase app build.
- New customers raise an admin notification (gated by `notifications.userRegistrations`, default on). Turn it off in settings if it is noisy.
