const Notification = require('../models/Notification');
const { getAdminSettings } = require('./settingsCache');
const logger = require('../utils/logger');

/**
 * Notifications to the admin feed.
 *
 * notifyAdmins() is the single producer. It never throws into the caller's
 * request — a missed notification must not fail a booking or a sign-up.
 *
 *   settingKey          notifications.<key> in AdminSettings that can switch
 *                       this kind off (providerRegistrations, userRegistrations,
 *                       systemAlerts)
 *   requiredPermission  only admins with it see the notification
 *   dedupeKey           at most one notification per key
 */
async function notifyAdmins({ type, title, message, severity = 'info', target, requiredPermission = null, dedupeKey, settingKey, adminId = null }) {
  try {
    if (settingKey) {
      const settings = await getAdminSettings();
      if (settings.notifications?.[settingKey] === false) return null;
    }
    return await Notification.create({
      adminId,
      type,
      title,
      message,
      severity,
      target: target ? { type: target.type, id: target.id, providerId: target.providerId || undefined } : undefined,
      requiredPermission,
      dedupeKey,
    });
  } catch (err) {
    if (err.code === 11000) return null; // already notified (dedupeKey)
    logger.error({ err, type }, 'admin notification failed');
    return null;
  }
}

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

// ---- the events admins need to hear about ----

const NotificationService = {
  notifyAdmins,

  notifyProviderRegistration: (provider) =>
    notifyAdmins({
      type: 'provider_registration',
      title: 'New provider sign-up',
      message: `${provider.fullName} signed up as ${provider.providerType}. They still have to submit their profile.`,
      target: { type: 'Provider', id: provider._id },
      requiredPermission: 'canApproveProviders',
      settingKey: 'providerRegistrations',
    }),

  notifyProviderSubmitted: (provider) =>
    notifyAdmins({
      type: 'provider_submitted',
      title: 'Provider application to review',
      message: `${provider.fullName} submitted their ${provider.providerType} profile for approval.`,
      severity: 'warning',
      target: { type: 'Provider', id: provider._id },
      requiredPermission: 'canApproveProviders',
      settingKey: 'providerRegistrations',
    }),

  notifyUserRegistration: (user) =>
    notifyAdmins({
      type: 'user_registration',
      title: 'New customer',
      message: `${user.fullName} joined the platform.`,
      target: { type: 'User', id: user._id },
      requiredPermission: 'canManageUsers',
      settingKey: 'userRegistrations',
    }),

  notifyDoctorSubmitted: (doctor, name) =>
    notifyAdmins({
      type: 'doctor_verification',
      title: 'Doctor to verify',
      message: `${name || 'A doctor'} submitted their credentials for verification.`,
      severity: 'warning',
      target: { type: 'Doctor', id: doctor._id, providerId: doctor.providerId },
      requiredPermission: 'canManageHealthcare',
    }),

  notifyBrandSubmitted: (brand) =>
    notifyAdmins({
      type: 'brand_submitted',
      title: 'Brand application to review',
      message: `${brand.name} applied to sell on the platform.`,
      severity: 'warning',
      target: { type: 'Brand', id: brand._id, providerId: brand.owner || undefined },
      requiredPermission: 'canManageShopping',
    }),

  notifyDisputeOpened: (dispute) =>
    notifyAdmins({
      type: 'dispute_opened',
      title: 'New home-service dispute',
      message: `The ${dispute.role} raised a dispute: ${dispute.reason}`,
      severity: 'warning',
      target: { type: 'Dispute', id: dispute._id },
      requiredPermission: 'canManageHomeServices',
    }),

  notifyPayoutRequested: (payout, providerName) =>
    notifyAdmins({
      type: 'payout_requested',
      title: 'Payout request',
      message: `${providerName || 'A provider'} asked for a payout of PKR ${payout.amount}.`,
      severity: 'warning',
      target: { type: 'PayoutRequest', id: payout._id, providerId: payout.provider },
      requiredPermission: 'canManageFinance',
    }),

  notifyReturnRequested: (ret) =>
    notifyAdmins({
      type: 'return_requested',
      title: 'Return requested',
      message: `A customer asked to return an order: ${ret.reason}`,
      target: { type: 'ReturnRequest', id: ret._id },
      requiredPermission: 'canManageShopping',
    }),

  notifyAdjustmentPending: (adjustment) =>
    notifyAdmins({
      type: 'wallet_adjustment_pending',
      title: 'Wallet adjustment needs a second approver',
      message: `${adjustment.direction === 'credit' ? 'Credit' : 'Debit'} of PKR ${adjustment.amount}: ${adjustment.reason}`,
      severity: 'warning',
      target: { type: 'WalletAdjustment', id: adjustment._id },
      requiredPermission: 'canManageFinance',
    }),

  // One alert per day while the ledger is out of balance.
  notifyReconciliationDrift: (result) =>
    notifyAdmins({
      type: 'reconciliation_drift',
      title: 'Wallet ledger out of balance',
      message: `Wallet balances differ from the ledger by PKR ${result.drift}.`,
      severity: 'error',
      requiredPermission: 'canManageFinance',
      settingKey: 'systemAlerts',
      dedupeKey: `reconciliation_drift:${dayKey()}`,
    }),

  // A verified Stripe event we failed to apply — money may be unrecorded.
  notifyPaymentWebhookFailed: (eventId, reason) =>
    notifyAdmins({
      type: 'payment_webhook_failed',
      title: 'Payment event failed to apply',
      message: `Stripe event ${eventId} could not be applied: ${reason}`,
      severity: 'error',
      requiredPermission: 'canManageFinance',
      settingKey: 'systemAlerts',
      dedupeKey: eventId ? `payment_webhook_failed:${eventId}` : undefined,
    }),
};

module.exports = NotificationService;
