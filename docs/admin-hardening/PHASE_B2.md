# Phase B2 — authorization, unified audit, admin management, money safety, soft delete

Fixes BE-R1, BE-R2, BE-R3, BE-R4, BE-R5, BE-R6, BE-D5 and the server half of X5.

## What changed

| Area | Before | After |
|---|---|---|
| Home-services admin | `[protect, adminOnly]` only — any admin could refund, resolve disputes, decide payouts, change commission | `canManageHomeServices`; refunds also `canManageFinance`; payouts `canManageFinance`; dispute refunds/penalties need `canManageFinance` (controller check) |
| Wallet oversight | Any admin; adjust = two separate writes (balance, then ledger) | Everything `canManageFinance`; `WalletAdjustment` maker-checker above `finance.adjustmentApprovalThreshold` (default PKR 10,000; a **different** super admin approves); balance + ledger row in **one transaction**, idempotent per adjustment |
| Settings | No route guard (two inline checks) | `canManageSettings`; security and finance super-admin only |
| Healthcare | Reads open to every admin (patient data) | `canManageHealthcare` on reads and writes; refunds also `canManageFinance` |
| Shopping | Bespoke `requireShoppingAdmin` returning its own JSON | Standard named `requirePermission(canManageShopping)`; refunds also `canManageFinance` |
| Users / providers | Reads open to every admin | `canManageUsers` / `canApproveProviders` on reads too |
| Guard coverage | Unknown | `src/__tests__/adminRouteGuards.test.js` walks the real route table: every admin route authenticated unless on the explicit public list, every mutation names a guard, sensitive reads too, money routes need finance |
| Audit | `Admin.activityLog` (enum crashed **after** the action for 4 actions) + 4 write-only module logs | One `AdminAuditLog` written by every admin mutation (`services/auditService.js`, never throws, redacts secrets, stores only changed fields) |
| Admin management | None (only the seeder) | `/api/admin/admins`: list/view (canManageAdmins), create + role/permission changes (super admin), disable, reset password, reset 2FA, view/revoke sessions; no self-modification; super-admin targets need a super admin; temporary passwords shown once |
| Deletes | Hard delete, no checks, 500 afterwards (enum) | Soft delete with reason; 409 `DELETE_BLOCKED` + reasons for open bookings / upcoming appointments / open orders / pending payouts / wallet balance; deleted accounts hidden from every query (plugin) but history still populates; email released; super-admin restore |
| Provider submissions | Two approval flows, one orphaned | Provider-document flow is canonical; the orphaned admin queue, its model and 11 dead handlers deleted |
| Bugs found on the way | Provider activate/deactivate always 404 (wrong route param) | Fixed |
| Duplicate `adminOnly` | Two implementations | One (`authMiddleware.adminOnly`) — done in B1 |

## Evidence

- `adminRouteGuards.test.js` (5), `adminAuthorization.test.js` (25 — 13 moderator 403s incl. refund/dispute/payout/wallet/settings/admin CRUD, permission holders pass the guard, admin-management rules, sign-out on disable/reset, no password in audit), `adminWallet.test.js` (9 — below/above threshold, second approver, double approval refused, insufficient balance moves nothing, apply-once, reconciliation), `adminAccountDeletion.test.js` (8 — 409 reasons, soft delete, sign-out, email reuse, history populate, aggregation filter, restore rules), `adminMigrations.test.js` (5).
- Full suite: **54 suites / 641 tests pass**. Lint: 0 errors, 120 warnings (down from 123). `dump-routes --check` up to date (474 routes).

## Not verified / blocked

- Production data: run migrations 01 → 02 → 03 (dry first). 03 keeps the old audit collections unless re-run with `--drop-legacy`.
- With a single super admin, adjustments above the threshold cannot be approved (by design). Create a second super admin, or raise the threshold, before relying on large adjustments. Recorded in open items.
- No admin UI yet for wallet adjustments/approvals (finance UI is F5, SHOULD).

## New risks

- **Breaking for the current admin app**: healthcare/shopping/wallet 403 bodies now use the admin envelope; deletes require a reason and answer with the new envelope.
- Moderators keep the schema-default flags they always had (`canManageUsers`, `canManageShopping`, `canManageHealthcare` true). Review existing moderators in the admin-management screen after deploy.
- Soft-delete plugin: any code that relies on `find()` returning deleted accounts must pass `{ withDeleted: true }`. Only id-batch lookups (populate) are exempt.
