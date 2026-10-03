# Admin settings — what each one does

Rule: **a setting the admin can change must change behaviour.** Before
admin-hardening, several settings were stored and editable in the admin app
but read by nothing, so the console showed controls that did nothing. Every
remaining setting below names the code that enforces it; the editable platform
settings are defined (with types, limits and consumers) in
`src/config/platformSettings.js`, and `GET /api/admin/settings` returns that
spec so the app renders controls from the server.

## Platform settings (`/api/admin/settings`)

| Section.field | Who can change it | Enforced by |
|---|---|---|
| general.platformName | `canManageSettings` | `GET /api/admin/meta` (app shows it) |
| general.contactEmail | `canManageSettings` | `services/adminEmailService.js` — recipient of operational emails when `ADMIN_EMAIL` is unset |
| general.supportPhone | `canManageSettings` | `GET /api/admin/meta` |
| general.maintenanceMode / maintenanceMessage | `canManageSettings` | `middleware/maintenance.js` — 503 for the user/provider API; admin, health, cron and Stripe webhook stay open |
| notifications.emailNotifications | `canManageSettings` | `services/adminEmailService.js` |
| notifications.providerRegistrations / userRegistrations / systemAlerts | `canManageSettings` | `services/notificationService.js` |
| security.twoFactorEnabled | super admin | Super admins must enrol TOTP before the console opens (`services/admin/sessionRestrictions.js`) |
| security.sessionTimeout (min) | super admin | Idle sign-out (`services/admin/sessionService.js`) |
| security.maxLoginAttempts / lockoutMinutes | super admin | Per-account sign-in lockout (`controllers/admin/auth.js`) |
| security.passwordExpiry (days, 0 = never) | super admin | Forces a password change once the password is older (`sessionRestrictions.js`) |

Module settings keep their own endpoints and are all read by payment,
matching or checkout code: `/api/shopping/admin/settings`,
`/api/v1/admin/healthcare/settings`, `/api/admin/homeservice/settings`.

## Removed (stored and editable, enforced nowhere)

| Setting | Decision | Why |
|---|---|---|
| general.timezone, general.language | Removed | Nothing read them; the platform runs in Asia/Karachi (`utils/time.js`) and the timezone is served by `/meta`. |
| general.autoApproveProviders | Removed | Never wired; provider approval is a deliberate admin decision. |
| general.requireEmailVerification | Removed | Email verification is always required by the sign-up flow; the toggle changed nothing. |
| notifications.pushNotifications, notifications.weeklyReports | Removed | No push channel to admins and no weekly report exist. |
| security.ipWhitelist | Removed | Admins use the mobile app on changing networks; an IP allow-list would lock them out and was never enforced. |
| appearance.* (theme, primaryColor, accentColor, compactMode) | Removed | The app's theme is a per-device preference with a fixed design system; a platform-wide colour setting contradicted it and nothing read it. |
| healthcare.defaultSlotDurationMinutes, maxAdvanceBookingDays, autoApproveDoctors | Removed | Editable in the admin app, read by no booking or approval code. |
| homeservice.cancellationWindowHours | Removed | No cancellation path read it; customer cancellation follows booking status (`statusMap.js`). |

`scripts/migrations/01-admin-auth-cleanup.js` unsets these fields from the
stored settings document.
