# Baseline — before admin-hardening (2026-10-01, `main` @ 4a2a3e5)

| Gate / metric | Before |
|---|---|
| `npm test` | 43 suites / 520 tests pass **with the 5 real-DB suites excluded** (they connect to `MONGODB_URI` from `.env` = the shared dev/demo Atlas DB; the baseline was run with that URI blocked). |
| `npm run lint` | Fails — no ESLint config exists ("Oops! Something went wrong"). |
| `node scripts/dump-routes.js --check` | Script did not exist. |
| Tracked files under `node_modules/` | 13,349 of 13,693 tracked files. |
| Credential literals in tracked files | Super-admin email+password (seeder, seed-accounts, 4 QA scripts, 3 docs), moderator password, demo passwords in 15+ scripts and docs. |
| Admin test files | 3 (`shopping/__tests__/adminAuth`, `homeservice/__tests__/adminGuard`, `__tests__/adminWallet`) — none for `adminController`, `settingsController`, `notificationController`. |
| `src/controllers/adminController.js` | 2,262 lines. |
| `console.*` in `src/` (non-test) | 278. |
| Admin mutating routes without a named permission guard | Not measurable (no route table). Measured after B0: see `docs/ROUTES.json`. |

## After B0

| Gate / metric | After B0 |
|---|---|
| `npm test` | **48 suites / 544 tests pass**, all on an in-memory replica set (no remote DB reachable from tests). |
| `npm run lint` | **0 errors, 123 warnings** (warnings to be ratcheted down; new code adds none). |
| `node scripts/dump-routes.js --check` | Passes; 459 routes in `docs/ROUTES.json`. |
| Tracked `node_modules/` files | **0**. |
| Credential literals in tracked files | Only example payloads in API docs (`"password": "password123"` request examples) and test-only secrets in `test/setupEnv.js`. |
