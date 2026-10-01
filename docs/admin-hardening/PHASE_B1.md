# Phase B1 — admin authentication, sessions, lockout, TOTP, real settings

Fixes BE-S3, BE-S4, BE-S5, BE-S6 and the backend half of X1.

## What changed

| Area | Before | After |
|---|---|---|
| Refresh | Verified with `JWT_SECRET` (signed with `REFRESH_TOKEN_SECRET`) **and** mounted behind `protect` → could never succeed | `POST /api/admin/auth/refresh-token` is public, verifies with the refresh secret, rotates the token, returns `accessTokenExpiresAt` + `expiresInSeconds` read from the token |
| Sessions | One plaintext `Admin.refreshToken`; second device kicked out the first | `AdminSession` per device, hashed refresh token, rotation + **reuse detection**, `GET /sessions`, `DELETE /sessions/:id`, `POST /auth/logout-all`; access tokens carry `sid` and `protect` checks the session on every admin request |
| Token types | Refresh and access told apart only by secret | `typ: 'access' \| 'refresh' \| 'mfa'`; `protect` accepts access tokens only |
| Brute force | General limiter only (300/10 min/IP, in-memory per instance) | MongoDB-backed lockout per account (`maxLoginAttempts`, `lockoutMinutes`) and per address (20/15 min); 429 + `Retry-After`; every failure/lock audited |
| Enumeration | "Deactivated" returned before password check | Unknown email ≡ wrong password; deactivation shown only after the password |
| Security settings | Stored, editable, enforced nowhere | `sessionTimeout` (idle sign-out), `maxLoginAttempts` + `lockoutMinutes`, `passwordExpiry` (forced change), `twoFactorEnabled` (super admins must enrol TOTP) |
| 2FA | None | TOTP (RFC 6238) enrol/verify/disable, sign-in challenge step, 10 single-use recovery codes, replay-proof, secrets AES-256-GCM at rest |
| Password change | No strength check, other sessions kept | ≥10 chars + deny-list, other sessions revoked, audited; `mustChangePassword` flow |
| Maintenance mode | Stored only | Enforced (503 for user/provider API; admin/health/cron/webhook exempt) |
| Unused settings | 14 placebo controls | Removed (`docs/ADMIN_SETTINGS.md`); settings GET returns a spec the app renders from |
| Start-up | Logged whether `JWT_SECRET` existed | Refuses to start on missing secrets, equal JWT/refresh secrets, or (prod) missing `TOTP_ENC_KEY` |
| Error shape (admin) | 6+ shapes | `{ success:false, error:{code,message,details?}, requestId }` |

## Evidence

- `src/__tests__/adminAuthSessions.test.js` — 29 cases, all passing: 3+ access-token lifetimes via refresh; refresh without an access token; reuse revokes the session (and audit row); refresh token rejected as bearer; per-device sessions; logout / logout-all / revoke by id; password change signs out other devices; weak password rejected; 6th bad login → 429 even with the right password, unlocks after the window; `maxLoginAttempts` changed through the API changes the lock point; per-address cap; idle timeout and activity keep-alive; `mustChangePassword`, `passwordExpiry`, `twoFactorEnabled` restrictions; TOTP sign-in, wrong code, no replay, recovery code once; maintenance 503 + exemptions; settings validation, permissions, audit before/after.
- `src/__tests__/adminTotp.test.js` — RFC 6238 Appendix B vectors (19 cases).
- Full suite: 50 suites / 592 tests pass. Lint: 0 errors, 123 warnings (no new ones). `grep 86400` in token code: none.

## Not verified / blocked

- Production `JWT_EXPIRE` and whether `JWT_SECRET === REFRESH_TOKEN_SECRET` on Vercel (owner, open item 2). If they are equal, the new start-up check **will refuse to boot** — set distinct secrets before deploying.
- `TOTP_ENC_KEY` must be added to Vercel before deploying (start-up refuses without it in production).
- The realtime (Socket.IO) service verifies access tokens itself; it should also reject `typ: 'refresh'` — separate repo, added to open items.

## New risks / deploy notes

- **Breaking for the current admin app**: login/refresh response shape and error shape changed; every existing admin session ends (tokens without `sid` are refused). Ship with the F1 app build.
- Run `scripts/migrations/01-admin-auth-cleanup.js` after deploy — production has `autoIndex` off, so the TTL and unique indexes of the new collections only exist after it (or `scripts/sync-indexes.js`).
- With the default `passwordExpiry` of 90 days, any admin whose password is older than that (by `passwordChangedAt`, else account creation) must change it at next sign-in. That includes the current super admin — intended, given the leaked password.
