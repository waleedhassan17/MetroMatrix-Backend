# Admin console — QA verification matrix

Status as of 2026-10-03, branch `admin-hardening` in both repos.

**Evidence sources**

| Code | Source | Result on 2026-10-03 |
|---|---|---|
| BE | Backend jest suite, run on an in-memory replica set (`npm test`) | 60 suites / 698 tests passed, twice in a row |
| FE | App jest suite (`npx jest`) | 14 suites / 247 tests passed |
| E2E | `e2e/adminConsole.e2e.test.ts` in the app, driving the app's own network layer over HTTP against `npm run dev:memory` (backend). Run with `JWT_EXPIRE=1m`. | 11 / 11 passed |
| Gate | `scripts/*` gates in each repo | — |

**Result values**

- **Pass**: verified by the evidence named in the row.
- **Partial**: the server side is verified; part of the expected behaviour is
  deferred, and the row links the open item.
- **Blocked**: needs a person with a device; the row links the open item.

| ID | Area | Result | Evidence |
|---|---|---|---|
| Q01 | Auth: valid / invalid / deactivated login | **Pass** | BE `adminAuthSessions`: "answers a wrong password and an unknown email identically", "only reveals deactivation after the password is proven". E2E Q01. Credential logs: FE `devLog` redaction tests; `no console.log of auth data` gate = 0. |
| Q02 | Auth: lockout by email, then by IP | **Pass** | BE: "locks the account after N failures — even the right password — and unlocks after the window"; "also caps failures per address across different emails"; "changing maxLoginAttempts through the API changes when the lock happens". Audit rows `admin.login.failed` / `admin.login.locked`. E2E Q06 (429 + `retryAfterSeconds`). FE `adminAuth.test` shows the lockout copy. |
| Q03 | Auth: 3+ access-token lifetimes | **Pass** (automated); real-time workday **Blocked** → item 18 | BE: "keeps an admin signed in across 3+ access-token lifetimes". FE `authRecovery.test` (refresh-and-replay), `refreshScheduler.test` (renew 60 s before expiry, foreground only). E2E Q03: a rejected token is renewed transparently and the refresh token rotates. |
| Q04 | Auth: replay a rotated refresh token | **Pass** | BE: "replaying a rotated refresh token revokes the session (reuse detection)". E2E Q05: after sign-out, the old refresh token gets 401. |
| Q05 | Auth: password change / deactivation from another device | **Pass** | BE: "changing the password signs out every other device"; `adminAuthorization` "disabling an admin signs them out everywhere at once" and "a password reset … ends the target's sessions". FE: the session-ended event signs the app out (`AdminSessionManager`) and `AdminGate` sends the screen to sign-in (`adminAuth.test` gate table). |
| Q06 | Auth: concurrent requests with an expired token | **Pass** | FE `authRecovery.test`: "two concurrent admin 401s cause exactly one admin refresh". E2E Q04: three parallel requests with a rejected token; the session survives (a second refresh would have replayed the rotated token and revoked it). |
| Q07 | RBAC: moderator calls money, settings and admin routes | **Pass** | BE `adminAuthorization`: "a moderator with default permissions (Q07) … → 403" for each route, and "nothing it was refused left an audit row". BE `adminForbiddenMatrix`: an admin with no permissions gets 403 on every guarded route (driven by the route table). UI hides the actions: `PermissionGate` around Refund, Payouts, Settings writes, Admins, delete actions; tabs by permission. |
| Q08 | RBAC: role edits; demoting the last super admin | **Pass** | BE: "only a super admin can … change roles and permissions", "nobody changes their own role…", "the last active super admin cannot be demoted or disabled" (all audited). FE `AdminDetailScreen` shows the server's refusal in the confirm sheet. |
| Q09 | RBAC: non-admin token on admin routes; deep link | **Pass** | BE `adminForbiddenMatrix`: "a customer token never gets into the admin API (401/403)". FE: every admin route renders through `AdminGate`; with no admin session the decision is redirect to `AdminSignIn` (`adminAuth.test`, 11 cases); `reachability.test`. |
| Q10 | Overview on a fresh database | **Pass** | BE: "on an empty database: honest zeros, null growth, no invented numbers (Q10)". FE `adminData.test`: missing values render "—", a real zero renders 0; `metrics.test` ("no baseline last month"); Overview shows "All clear" for empty queues. |
| Q11 | Overview: one module fails | **Pass** | BE: "a failing module comes back unavailable; everything else still renders (Q11)". FE Overview renders an error block for that module only. |
| Q12 | Growth across a month boundary, baseline 0 and > 0 | **Pass** | BE: "crosses the year boundary…", "growth is null without a baseline, never 0 or an invented trend", "counts this month vs the same stretch of last month". |
| Q13 | Queue: approve a pending provider | **Pass** | E2E Q14/Q16: approve → state approved, history contains `provider.approve`, the overview queue count drops to 0. Provider emailed on approval (`emailProvider`). Queue tab badge uses the same counts (`AdminTabs`). Audit row: BE `adminConsoleData` providers tests. |
| Q14 | Reject without a reason | **Pass** | Server: BE "suspend and reject require a reason". Client: `ConfirmSheet requireReason` disables Reject until a reason is entered. |
| Q15 | Search / filter / paginate 500+ | **Pass** | BE: "clamps the page size and ignores unknown sort fields", "cursor paging walks the whole list without repeats". FE: `useDebouncedValue` (350 ms), infinite queries; `flattenPages` de-duplicates by id (`adminData.test`). |
| Q16 | Delete with an open booking, order or balance | **Pass** | BE `adminAccountDeletion`: refused while a booking is open, the wallet holds money, or a payout is pending (409 `DELETE_BLOCKED` with reasons). FE provider and customer detail list the reasons in the sheet; nothing is deleted. |
| Q17 | Delete a clean record | **Partial** → item 15 | BE: "soft-deletes a clean account: hidden everywhere, signed out, email free, history intact, audited"; "only a super admin restores…". No restore screen yet. |
| Q18 | Home services: force status, refund, dispute, payout | **Pass** | Server state machine: BE `stateMachine.test`. Guards: `adminRouteGuards` "money-moving routes require canManageFinance". Refund cap: BE `adminRefunds.test` (default remainder, partial, unpaid refused, dispute counted against the same cap, a race pays out once). E2E Q19: refund defaults to the amount paid and a repeat gets 409. FE screens show the server's refusal verbatim. |
| Q19 | Finance: wallet adjustment below / above the threshold | **Pass** (server); UI **Partial** → item 11 | BE `adminWallet`: applied at once with balance, ledger row and audit row together; above the threshold waits for a different super admin; applied at most once (now also claimed inside the transaction). Finance screens are F5. |
| Q20 | Finance: reconciliation with a seeded mismatch | **Partial** → item 11 | BE: reconciliation drift raises a notification once per day ("a recurring alert is raised once per key"); overview queue `reconciliation_drift`. No finance screen yet. |
| Q21 | Healthcare: appointments, doctors, specialties, clinics, reviews | **Partial** → items 16, 18 | Data layer fixed (F2): error envelope, `meta` paging, doctor list (was always empty), DELETE bodies; specialty reactivation now real (BE `adminSpecialties.test`). Visual migration is deferred and the screens were not exercised on a device. |
| Q22 | Healthcare analytics: partial data / failure | **Pass** | Screen rewritten (F2): only `/analytics/*` figures, "—" when missing, an error with retry per section, the Export button removed. The dummy slice is deleted; the static-data gate is 0. |
| Q23 | Shopping: brand, outlet, banner, order | **Blocked** → item 18 | Backend shopping suites pass. Envelope compatibility fixed (orders `pagination`, error objects). Needs a device and Cloudinary. |
| Q24 | Notifications per admin | **Pass** | BE: "reading or dismissing affects only the caller, and admins only see their kind of work"; producers for disputes, payouts, returns and submissions. FE: notifications screen (per-admin read state, deep links: `notificationTarget.test`), More-tab badge. |
| Q25 | Settings change behaviour and persist | **Pass** | BE: maintenance mode 503 with exemptions; idle timeout signs out; lockout settings change lockout; `passwordExpiry` and `twoFactorEnabled` restrict sessions; settings validated, unknown keys refused. FE settings screen is rendered from the server spec (values reload from the server). HS settings validated (BE `adminSettings.test`). |
| Q26 | Audit: 10 mixed mutations | **Partial** → item 17 | Every mutation writes one audit row with actor, before/after, reason, IP and requestId (BE B2 suites, `adminSpecialties` checks exact actions). No audit read screen or filters yet (B4). |
| Q27 | Broadcast | **Blocked** (not in scope) → item 17 | B4. |
| Q28 | Export | **Blocked** (not in scope) → item 17 | B4. Healthcare's fake Export was removed. |
| Q29 | Contract | **Pass** | BE `adminContract` (spec ↔ routes both ways; responses satisfy the spec). FE: tsc checks every admin call against `generated/schema.d.ts`; `contract.typecheck.ts`; `sync-admin-spec.js --check` in CI; `adminCallsites.test` (admin endpoints only through the typed client, with listed exceptions). |
| Q30 | Static-data and design gates | **Pass** in the migrated scope; **Partial** admin-wide → item 16 | `no-static-data.sh`: 0 (enforced in CI). `design-gates.sh`: pass with `components/admin` and the migrated `screens/admin/*` in scope. Settings nothing reads: removed (`docs/ADMIN_SETTINGS.md`). `console.log` in admin code: 0. Hex: 423 remain in unmigrated healthcare/shopping screens. |
| Q31 | Theme and layout on devices | **Blocked** → item 18 | Automated: FE `contrast.test` covers the admin palette in light and dark (128 assertions); every screen uses `Screen`/`AppBar` safe areas. |
| Q32 | Screen reader | **Blocked** → item 18 | In code: roles and labels on rows, tiles, switches and buttons; tap targets ≥ 44 pt (small buttons removed). |
| Q33 | Resilience: airplane mode, double tap | **Partial** → items 18, 19 | Double submit: a repeated approve gets 409; refunds and wallet adjustments are claimed atomically (BE race tests); payouts are idempotent by ledger key; confirm buttons are disabled while busy. Offline: a refresh that cannot reach the server keeps the session (FE `sessionRefresh.test`, `authRecovery.test`). Airplane mode on a device is not run. |
| Q34 | Security | **Pass** | No tokens in Redux (one SecureStore record). `devLog` redaction; token and response logs removed. BE: the secret scan only reports items in `docs/SECURITY_ROTATION.md`; 0 tracked `node_modules`; no credential literals. No crash reporter yet (item 13). Rotation itself is item 1. |
| Q35 | Ops: database down, bad env | **Pass** | BE `healthAndConfig`: "is not ready without a database", refuses to start without required secrets or with equal access/refresh secrets, production requires `TOTP_ENC_KEY`. |

**Totals:** 24 Pass · 6 Partial · 5 Blocked (3 need a device, 2 are out of scope).
