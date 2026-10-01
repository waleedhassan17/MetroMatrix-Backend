/**
 * Admin roles and permission flags — the one definition the server enforces
 * and GET /api/admin/meta serves to the app (labels, descriptions, presets),
 * so the console never hardcodes its own list.
 *
 * A super admin has every flag. Some actions are super-admin only and no flag
 * can grant them (see SUPER_ADMIN_ONLY).
 */
const PERMISSIONS = Object.freeze([
  { key: 'canApproveProviders', label: 'Approve providers', description: 'Review, approve, reject, suspend and delete providers.' },
  { key: 'canManageUsers', label: 'Manage users', description: 'View customer accounts; activate, deactivate and delete them.' },
  { key: 'canManagePosts', label: 'Moderate posts', description: 'Remove community posts.' },
  { key: 'canViewAnalytics', label: 'View analytics', description: 'Platform and module analytics.' },
  { key: 'canManageNotifications', label: 'Manage notifications', description: 'Clear the shared admin notification feed.' },
  { key: 'canManageShopping', label: 'Shopping', description: 'Brands, outlets, banners, orders and shopping settings.' },
  { key: 'canManageHealthcare', label: 'Healthcare', description: 'Doctors, appointments, clinics, reviews and healthcare settings.' },
  { key: 'canManageHomeServices', label: 'Home services', description: 'Bookings, disputes, categories and home-services settings.' },
  { key: 'canManageFinance', label: 'Finance', description: 'Refunds, payout decisions, wallet adjustments and reconciliation.' },
  { key: 'canBroadcast', label: 'Broadcasts', description: 'Send notifications to users and providers.' },
  { key: 'canViewAudit', label: 'Audit log', description: 'Read the admin audit trail.' },
  { key: 'canManageSettings', label: 'Platform settings', description: 'General and notification settings.' },
  { key: 'canManageAdmins', label: 'Manage admins', description: 'View admins, disable them and revoke their sessions.' },
]);

const SUPER_ADMIN_ONLY = Object.freeze([
  'Create admins and change roles or permissions',
  'Security settings',
  'Finance settings (adjustment approval threshold)',
  'Approve wallet adjustments above the threshold (a different super admin than the requester)',
  'Restore deleted users and providers',
]);

const all = (value) => Object.fromEntries(PERMISSIONS.map((p) => [p.key, value]));

// Starting permissions when a super admin creates an admin with this role;
// they can then be adjusted one by one.
const ROLE_PRESETS = Object.freeze({
  super_admin: all(true),
  admin: {
    ...all(false),
    canApproveProviders: true,
    canManageUsers: true,
    canManagePosts: true,
    canViewAnalytics: true,
    canManageNotifications: true,
    canManageShopping: true,
    canManageHealthcare: true,
    canManageHomeServices: true,
  },
  moderator: {
    ...all(false),
    canApproveProviders: true,
    canManagePosts: true,
    canViewAnalytics: true,
  },
});

const ROLES = Object.freeze([
  { value: 'super_admin', label: 'Super admin', description: 'Every permission, plus the super-admin-only actions.' },
  { value: 'admin', label: 'Admin', description: 'Runs the modules. No money, settings or admin management unless granted.' },
  { value: 'moderator', label: 'Moderator', description: 'Reviews providers and content.' },
]);

const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

module.exports = { PERMISSIONS, PERMISSION_KEYS, ROLES, ROLE_PRESETS, SUPER_ADMIN_ONLY };
