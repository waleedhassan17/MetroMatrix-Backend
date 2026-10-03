# Phase B0 — safety & hygiene baseline

## What changed

| Commit | Change |
|---|---|
| `admin(be): stop tracking node_modules` | 13,349 files untracked (nothing deleted on disk). |
| `admin(be): run every test suite on an in-memory replica set` | `jest.config.js` + `test/globalSetup.js` (single-node `MongoMemoryReplSet`, so transactions work) + `test/setupEnv.js` (one DB per test file; **refuses any non-local host**; test-only secrets). The 5 suites that used to hit the shared Atlas DB now run in memory. |
| `admin(be): seeders take credentials from env and refuse unnamed targets` | `scripts/seed-admin.js` replaces the credential-bearing `src/seeder/adminSeeder.js` (env credentials, never printed, `mustChangePassword`, no moderator). `scripts/lib/seedSafety.js`: `--confirm-db=<name>` required, `NODE_ENV=production` refused without `--i-know`, one `SEED_DEMO_PASSWORD`, `QA_ADMIN_EMAIL/PASSWORD` for QA scripts. Applied to all seed and QA scripts that write data. Credential tables removed from docs; personal-address fallbacks removed (admin notification email now goes through `services/adminEmailService.js`, which also finally honours `notifications.emailNotifications`). Deleted `seedLocal.tmp.js`, `api_health_check.js`. |
| `admin(be): history secret scan and rotation register` | `scripts/secret-scan-history.js` (reports commit/file/kind, never values); `docs/SECURITY_ROTATION.md`; `docs/ADMIN_OPEN_ITEMS.md`. |
| `admin(be): ESLint gate, route table and CI workflow` | `.eslintrc.cjs`; fixed duplicate schema keys (User/Provider); `src/utils/routeTable.js` + `scripts/dump-routes.js` → `docs/ROUTES.json` with `--check`; named guards/limiters (`utils/named.js`); `.github/workflows/ci.yml` (lint, test, route check, npm audit report-only, gitleaks). |
| `admin(be): structured logging with request ids` | pino logger with redaction; `middleware/requestId.js`; error handler logs 5xx with the request id; `console.*` replaced in `authController`, admin controllers and middleware. |

## Evidence

- `npx jest --runInBand` → 48 suites / 544 tests passed.
- `npm run lint` → 0 errors (123 warnings).
- `node scripts/dump-routes.js --check` → up to date.
- `node scripts/seed-accounts.js` (no flag) → refuses, names the target DB, exit 1, no connection made. `NODE_ENV=production node scripts/seed-admin.js --confirm-db=x` → refuses, exit 1.
- `git ls-files node_modules | wc -l` → 0.

## Not verified / blocked

- CI has not run: branches are not pushed (open item 5).
- Rotation of leaked secrets — owner action (open item 1). **The backend `.env` was committed twice in history**, so every secret in it must be rotated, not only the admin password.
- `gitleaks` was not run locally (not installed); the history scan used `scripts/secret-scan-history.js`. CI runs gitleaks on pushes.

## New risks

- Seed and QA scripts now need `SEED_DEMO_PASSWORD` (8+ chars) and `--confirm-db=<db>`; team members running the old commands will get a clear refusal message. Existing demo accounts keep their old passwords until re-seeded.
- `docs/ROUTES.json` must be regenerated (`node scripts/dump-routes.js`) whenever a route or its middleware changes, or CI fails — intended.
