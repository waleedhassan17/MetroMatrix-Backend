# Admin console hardening — final report

**Date:** 2026-10-04
**Branches:** `admin-hardening` in MetroMatrix-Backend (25 commits) and
Waleed-MetroMatrix (9 commits). **Not pushed.**
**Scope:** every MUST phase — B0, B1, B2, B3, B5, F0, F1, F2, F3, F4 waves
1–3, and the §5 release documents. The app keeps the admin console as a
role-gated area; it is not a separate build.

**Follow-up, 2026-10-06 — phase C** (`PHASE_C.md`): the platform commission was
removed (providers are paid in full; migration 06), every provider in the
console opens their details and analytics, and the core console screens got
charts and a UI pass.

The deploys are coupled. Admin sign-in, token refresh and the response
envelope changed together, so the backend and an app build from this branch
must ship together (`docs/RELEASE_CHECKLIST.md`).

## Before / after

### Backend

| Metric | Before | After |
|---|---|---|
| Tracked files under `node_modules/` | 13,349 of 13,693 | **0** |
| Tests | 43 suites / 520 tests, with the 5 suites that hit the shared Atlas DB excluded | **60 suites / 698 tests**, all on an in-memory replica set (tests refuse any non-local DB) |
| Lint | No config; the command failed | **0 errors** (114 warnings, ratcheted down from 123) |
| Route table | None | `docs/ROUTES.json` (472 routes), `--check` in CI |
| Admin mutating routes without a named permission guard | Not measurable: guards were anonymous inline checks, and B2 found settings, refunds, disputes, payouts and wallet routes unguarded | **0** (enforced by `adminRouteGuards.test.js` over the live route table; 5 public routes listed: sign-in ×2, TOTP step, refresh, provider submission — see open item 12) |
| Admin API contract | None | `docs/admin.openapi.yaml`; the test checks it against routes in both directions and validates responses |
| Admin test files | 3 | **16** |
| Largest admin controller | `adminController.js`, 2,262 lines | 686 lines (home-services admin); the core split into `controllers/admin/*` |
| `console.*` in admin controllers, middleware and services | Many, including a per-request `console.error` in `protect` | **0** (pino with redaction and request ids). 169 remain elsewhere in `src/`, outside admin. |
| Credential literals in tracked files | Super-admin, moderator and demo passwords in seeders, scripts and docs | None: seeders read env; the history scan lists only items already in `SECURITY_ROTATION.md` |

### App

| Metric | Before (F0 tree, today's scripts) | After |
|---|---|---|
| `tsc --noEmit` | 0 errors (the stale log listed 3) | 0, required in CI |
| Tests | 3 suites / 141 | **14 suites / 247**, plus an opt-in E2E (11 tests) against a live API |
| Static-data gate (data rules) | 237 hits (1,446 including hex) | **0**, enforced in CI |
| Screens with static or hybrid data | 5 | **0** |
| Reachable admin screens | 32 of 39 (82 %); notifications, settings, provider review and 3 service-provider tabs unregistered | **44 of 44 (100 %)**, reachability test with no allow-lists |
| Hex literals in admin code | 1,391 | 423, all in healthcare detail and shopping screens not yet migrated |
| `Alert.alert` in admin code | 99 | 42 (same screens) |
| `console.log` in admin code | 82, including token and response logs | **0** |
| Largest admin file | 2,258 (`adminDashboard.tsx`) | 1,186 (`SpecialtyManagementScreen.tsx`, not migrated); no migrated file is over 302 |
| Admin screens on the design kit | 1 | 27 |
| Admin emails hardcoded in the app | 2 lists (one with a personal address) | 0 |

## What changed

### Backend

**B0**
- Untracked `node_modules`; every test runs in memory.
- Seeders take credentials from env and refuse unnamed targets.
- History secret scan and a rotation register.
- ESLint, route table, CI, and structured logging with request ids.

**B1**
- Admin sessions with rotating, reuse-detected refresh tokens.
- Typed tokens and env validation.
- Mongo-backed lockout that doesn't leak which accounts exist.
- TOTP for super admins, with recovery codes.
- Restricted sessions (password change, 2FA enrolment).
- Every admin setting is enforced or removed; maintenance mode works.

**B2**
- Named permission guards on every admin route.
- One audit trail with before/after, reason, IP and request id.
- Admin management that protects the last super admin.
- Maker-checker wallet adjustments in one transaction.
- Soft delete with `DELETE_BLOCKED` reasons.

**B3**
- One response envelope; clamped pagination with cursors.
- Pakistan-time figures; growth is `null` without a baseline.
- Provider states from a single writer.
- `/meta`, `/overview` (modules fail independently) and the merged `/queue`.
- Per-admin notifications with producers.
- OpenAPI contract.

**B5**
- `/health/ready`, forbidden-access matrix, hygiene script, deploy and
  release docs.

**Found during the frontend work and fixed:**
- **Home-service refunds are capped at what the customer paid.** A double tap
  used to refund twice. The cap is enforced by a conditional claim, so
  concurrent requests can't both pay out.
- **Wallet adjustments are claimed inside their transaction.**
- **Specialty reactivation is real.** The app used to fake it.
- **Home-services analytics count Pakistan days and return `null`** instead of
  invented zeros.
- **Home-services settings are validated.**
- **Test runs are deterministic.**
- **`npm run dev:memory`** runs an isolated local API: no `.env`, random
  secrets, data in memory.

### App

**F0**
- Typed admin client generated from the contract, so a path or method the API
  lacks does not compile.
- Static-data gate and screen inventory.
- CI.

**F1**
- Staff sign-in, two-factor, password change and enrolment screens.
- One SecureStore session record.
- Per-audience single-flight refresh shared by every axios instance:
  - offline keeps the session;
  - a failed admin refresh never signs the customer out.
- Proactive refresh.
- `AdminGate` on every admin route; relaunch resumes the console.
- Permission hooks; redacted dev logging.

**F2**
- RTK Query data layer over the typed client.
- `/meta`-driven labels and tones; "—" for anything missing.
- Module network layers fixed for the new envelope. Error objects and `meta`
  had broken healthcare and shopping screens: the doctor list was always
  empty, and the orders list crashed.
- Fabricated slices deleted; healthcare analytics, hub and settings rewritten.

**F3**
- Tabs: Overview, Queue, People, Modules, More.
- Notifications with per-admin read state.
- Settings screen rendered from the server spec.
- Profile with two-factor and signed-in devices.
- Admin management.
- Reachability test.

**F4**
- Overview, Queue, People, provider and customer detail (reasons, blocked
  deletes, history).
- The seven home-services screens.
- Legacy dashboard and management screens deleted.

## Verification

- **Backend:** `npm test`, `npm run lint` and `node scripts/dump-routes.js
  --check` are green. The full suite ran twice in a row with no failures.
- **App:** `npx tsc --noEmit`, `npx jest`, `scripts/design-gates.sh` and
  `scripts/no-static-data.sh` are green.
- **End to end:** the app's own network code was run over real HTTP against
  `npm run dev:memory` with `JWT_EXPIRE=1m`. 11 of 11 checks passed:
  - restricted sign-in, and the password change that lifts it;
  - meta, queue and overview;
  - transparent refresh with rotation;
  - one refresh under concurrent 401s;
  - provider approval with history;
  - refund cap; reason required;
  - server-side sign-out; lockout with retry time.
- **QA matrix** (`docs/ADMIN_QA_MATRIX.md`):
  - 25 Pass, 5 Partial, 5 Blocked.
  - Every Partial or Blocked row names its open item.
  - Three rows need a person with a device: Q23, Q31, Q32.
  - Two are out of scope: Q27 broadcast and Q28 export.

## Definition of done

| # | Item | Status |
|---|---|---|
| 1 | Every finding fixed, or deferred with owner and reason | Done. Deferrals are in `docs/ADMIN_OPEN_ITEMS.md` (19 items). |
| 2 | Backend gates green; every admin mutation guarded and audited; no tracked `node_modules`; no credential literals; secret scan clean; **secrets rotated** | All done except rotation, which needs your console access (item 1). The CI workflow runs once the branch is pushed. |
| 3 | App gates green with `screens/admin` and `components/admin` in the design scope; no screen-local colour tables; no gradients; two radii; one accent | Met for `components/admin` and every migrated admin folder. The unmigrated healthcare detail and shopping screens still carry their own colours, so `screens/admin` as a whole is not in scope yet (item 16). |
| 4 | Nothing displayed is fabricated | Done: the static-data gate is 0 and enforced, and missing values render "—". |
| 5 | The session survives a workday; permissions enforced on the server and reflected in the UI | Done in automated tests (3+ lifetimes, proactive refresh, E2E). A real-time device session is item 18. |
| 6 | QA matrix with evidence | Done. |
| 7 | Final report with before/after counts | This document. |

## What is left for you

1. **Rotate every secret** in `docs/SECURITY_ROTATION.md`, super-admin password
   first (item 1).
2. **On Vercel:** confirm `JWT_SECRET` ≠ `REFRESH_TOKEN_SECRET` and add
   `TOTP_ENC_KEY` before deploying (items 2 and 7).
3. **Push both branches and open the PRs** (item 5). I have not pushed.
4. **Deploy in the order in `docs/RELEASE_CHECKLIST.md`:**
   1. migrations, dry-run first;
   2. `sync-indexes`;
   3. the backend and the new app build together.
5. **Run the device rows Q23, Q31, Q32 and Q33** on an EAS build (item 18).
6. **Decisions:**
   - a staging environment (item 4);
   - the history rewrite (item 3);
   - a second super admin (item 9);
   - reviewing existing admins' permissions (item 10).
