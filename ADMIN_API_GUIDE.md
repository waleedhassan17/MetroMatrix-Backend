# MetroMatrix admin console API — guide

The complete, tested contract is **`docs/admin.openapi.yaml`** (OpenAPI 3.0;
every admin route, its permission guard and its response schemas). This page
explains the parts you need to know before reading it. The previous version of
this guide (v74) described endpoints and shapes that no longer exist.

## Envelope

Every endpoint under `/api/admin`, `/api/v1/admin` and `/api/shopping/admin`:

```jsonc
// success
{ "success": true, "data": { … }, "meta": { "page": 1, "limit": 20, "total": 134, "pages": 7, "nextCursor": "…" } }
// failure
{ "success": false, "error": { "code": "DELETE_BLOCKED", "message": "…", "details": { … } }, "requestId": "…" }
```

- Branch on `error.code` (catalogue: `src/utils/errorCodes.js`), never on the message.
- `requestId` (also the `X-Request-Id` header) finds the request in the server logs.
- Lists: `limit` is clamped to 1–100; pass `cursor=<meta.nextCursor>` to page large lists.
- A figure with nothing to compare against has `delta: null` — show "—", not "0 %".

## Signing in

1. `POST /api/admin/auth/login {email, password, deviceLabel?}`
   - `data.step === 'signed_in'` → tokens + `admin`.
   - `data.step === 'totp_required'` → `POST /api/admin/auth/login/totp {challengeToken, code | recoveryCode}`.
   - 401 `INVALID_CREDENTIALS` (same for unknown emails), 403 `ACCOUNT_DEACTIVATED`, 429 `TOO_MANY_ATTEMPTS` (+ `Retry-After`).
2. Send `Authorization: Bearer <accessToken>`. `accessTokenExpiresAt` / `expiresInSeconds` are read from the token.
3. Before it expires (or on a 401), `POST /api/admin/auth/refresh-token {refreshToken}` — no access token needed. **The refresh token rotates every time; store the new one.** Presenting an old one revokes the session (`SESSION_REVOKED`).
4. `restrict` in the sign-in/refresh/profile response: `password_change` (temporary or expired password — only `PUT /api/admin/change-password` works) or `totp_enrol` (super admins must set up two-factor — `POST /api/admin/auth/2fa/enrol` + `/verify`).
5. Sessions end on logout, logout-all, password change, deactivation, role change, refresh-token reuse, or `security.sessionTimeout` minutes of inactivity (`SESSION_IDLE_TIMEOUT`).

## Permissions

The admin's effective permissions are in `admin.permissions` (a super admin has
all of them) and in `GET /api/admin/meta` → `viewer`. Every route's guard is in
the spec as `x-guards`. A missing permission is 403 `FORBIDDEN` with
`details.permission`; super-admin-only actions are 403 `SUPER_ADMIN_REQUIRED`.

## Reference data

`GET /api/admin/meta` returns every status list (with label and semantic tone),
provider types, specialties, service categories, cities, roles, permissions,
limits and feature flags. Don't hardcode any of them.

## The home screen

- `GET /api/admin/overview` — queues, KPIs (each with its period), one block per module the admin may see (`status: 'unavailable'` if that module failed), recent activity.
- `GET /api/admin/queue?type=&cursor=` — everything waiting for a decision, oldest first; each item has `target: { type, id }`.

## What changed from the old admin API (for the app)

| Old | Now |
|---|---|
| `/dashboard`, `/dashboard/stats`, `/dashboard/quick-stats`, `/dashboard/recent-registrations` | `GET /overview` |
| `/providers/pending`, `/providers/:type`, `/providers/:id/details` | `GET /providers?state=&type=…`, `GET /providers/:id` |
| `PUT /providers/:id/activate`, `/deactivate` | `PUT /providers/:id/unsuspend`, `/suspend {reason}` |
| Hard `DELETE /users/:id`, `/providers/:id` | Soft delete, `{reason}` required, 409 `DELETE_BLOCKED` with reasons; super-admin `POST …/restore` |
| `/provider-submissions` (admin queue) | Removed (it was always empty); use `/providers?state=pending` |
| `PUT /settings/appearance`, `GET /settings/notifications` | Removed; `GET /settings` returns `values` + `spec` |
| Global notification read state, delete for everyone | Per admin; `DELETE /notifications/:id` dismisses for you; `DELETE /notifications/purge` (canManageNotifications) |
| `expiresIn: 86400` | `accessTokenExpiresAt`, `expiresInSeconds` |
