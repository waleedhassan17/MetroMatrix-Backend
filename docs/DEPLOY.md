# Deploying the API

Production runs on Vercel (`api/index.js` → `src/app.js`), MongoDB Atlas, and
the separate MetroMatrix-Realtime service on Heroku. Set secrets only in the
Vercel/Heroku dashboards — never in this repository (it is public).

## Environment

The function **refuses to start** (`src/config/validateEnv.js`) if a variable
marked *required* is missing or invalid — a misconfigured deploy fails loudly
instead of serving.

| Variable | Required | Notes |
|---|---|---|
| `MONGODB_URI` | yes | Atlas connection string (replica set — transactions are used). |
| `JWT_SECRET` | yes | Access-token secret. 32+ random characters. |
| `REFRESH_TOKEN_SECRET` | yes | **Must differ from `JWT_SECRET`** (start-up refuses equal values). |
| `TOTP_ENC_KEY` | yes in production | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts admin 2FA secrets; changing it invalidates every enrolled authenticator. |
| `JWT_EXPIRE` | no (15m) | Access-token lifetime. |
| `REFRESH_TOKEN_EXPIRE` | no (90d) | User/provider refresh lifetime. |
| `ADMIN_SESSION_MAX_AGE` | no (7d) | Absolute lifetime of an admin session (idle timeout is the `security.sessionTimeout` setting). |
| `ADMIN_LOGIN_IP_MAX_FAILURES` | no (20) | Failed admin sign-ins per address per 15 min. |
| `CRON_SECRET` / `INTERNAL_API_KEY` | one of them | Scheduled maintenance endpoints reject every call without one (start-up only warns). |
| `CLIENT_URL` | yes for web clients | Added to the production CORS allow-list. |
| `ADMIN_EMAIL` | no | Recipient of operational admin emails; falls back to the `general.contactEmail` setting. |
| `SUPPORT_EMAIL` | no | Shown in the password-changed email. |
| Stripe (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, …), Cloudinary, SMTP (`EMAIL_*`), Firebase, Google/Facebook OAuth | per feature | See `.env.example`. |
| `LOG_LEVEL` | no | pino level; default `info` in production. |

## Health checks

- `GET /health` — liveness (the process answers).
- `GET /health/ready` — readiness: Mongo ping (2 s), configuration valid, and
  the count of audit writes that failed since start. 503 when not ready —
  point the uptime monitor here.

## Indexes

Production runs with Mongoose `autoIndex` off. After any deploy that adds or
changes an index, run `node scripts/sync-indexes.js --dry`, then without
`--dry`. The admin-hardening release adds TTL and unique indexes that the
security features depend on (admin sessions, login lockout, notification
dedupe) — see `docs/RELEASE_CHECKLIST.md`.

## Logs and request ids

Logs are JSON lines (pino) with credentials redacted. Every response carries
`X-Request-Id`; admin error bodies include it as `requestId` — search the logs
for it.
