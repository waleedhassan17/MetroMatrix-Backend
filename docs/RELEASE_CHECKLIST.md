# Release checklist — admin console hardening

Backend branch `admin-hardening` (MetroMatrix-Backend) and app branch
`admin-hardening` (Waleed-MetroMatrix) **ship together**: the admin sign-in,
token refresh and response envelope changed, so an app build from before this
release cannot use the new admin API. Customer and provider APIs are
unchanged.

## 0. Before anything else

- [ ] Secrets rotated — `docs/SECURITY_ROTATION.md` (super-admin password, everything that was in the committed `.env`, the Facebook app secret).
- [ ] `TOTP_ENC_KEY` added to Vercel (start-up refuses without it).
- [ ] `JWT_SECRET` ≠ `REFRESH_TOKEN_SECRET` on Vercel (start-up refuses equal values).
- [ ] A staging deploy exists (own Vercel project + own Atlas database + Stripe test keys) and the steps below were run there first.
- [ ] Atlas backups / point-in-time recovery on; take an on-demand snapshot right before step 2.

## 1. Deploy the backend

- [ ] CI green on the branch (lint, tests, `dump-routes --check`, gitleaks).
- [ ] Deploy; `GET /health/ready` returns 200.

## 2. Migrate (in this order; `--dry` first each time)

All migrations: `node scripts/migrations/<name>.js --confirm-db=<db name> [--dry]`. Each is idempotent.

| # | Migration | What it does | Rollback |
|---|---|---|---|
| 1 | `01-admin-auth-cleanup` | Unsets `Admin.refreshToken` and the 14 settings nothing enforced; builds the indexes for admin sessions, login lockout and the audit log. | None needed — the removed fields were never read. Re-deploy the previous release to roll back; admins sign in again. |
| 2 | `02-admin-permissions` | Makes `role` and `isSuperAdmin` agree; adds the new permission flags (false except for super admins). | Previous release ignores the new flags. |
| 3 | `03-audit-backfill` | Copies the four module audit collections and `Admin.activityLog` into `AdminAuditLog`; unsets `activityLog`/`stats`. Keeps the old collections — re-run with `--drop-legacy` once verified. | Delete `AdminAuditLog` rows with `source: /^backfill:/`. |
| 4 | `04-provider-status` | Fills `verificationStatus` + `isSuspended` from each provider's history. Does not touch `adminVerified`/`isActive` (login unchanged). | Previous release doesn't read `isSuspended`. |
| 5 | `05-notification-read-state` | Global `isRead` → per-admin `readBy`; adds `target`/`severity`; builds the dedupe index. | Previous release treats a missing `isRead` as unread. |

- [ ] Then `node scripts/sync-indexes.js --dry` and `node scripts/sync-indexes.js` (removes nothing; adds the new provider/notification indexes).

## 3. Clean production data

- [ ] `node scripts/audit-prod-hygiene.js --confirm-db=<db>` — lists seeded demo accounts and accounts using passwords that were committed to the repo.
- [ ] Review, then `--apply` (soft-deletes demo users/providers through the guarded path; deactivates admins with a known password).

## 4. Admins

- [ ] Every admin signs in again (old sessions are refused). Expect a forced password change where the password is older than `security.passwordExpiry` (default 90 days).
- [ ] Create a second super admin (needed to approve wallet adjustments above the threshold).
- [ ] Review each admin's role and permissions in admin management.
- [ ] Decide on `security.twoFactorEnabled` (require 2FA for super admins).

## 5. Ship the app

- [ ] EAS build from `admin-hardening` (see `BUILD_AND_SHARE.md` in the app repo) pointing at the same API.
- [ ] Smoke test: sign in (and 2FA if on), overview, queue, approve a test provider on staging, sign out.

## 6. Watch

- [ ] Uptime monitor on `/health/ready`.
- [ ] Admin notifications for reconciliation drift and failed payment events.
- [ ] `auditWriteFailures` in `/health/ready` stays 0.
