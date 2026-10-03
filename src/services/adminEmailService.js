const AdminSettings = require('../models/AdminSettings');
const { sendEmail } = require('./emailService');

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

/**
 * Operational email to the admin team.
 *
 * Recipient is ADMIN_EMAIL, else the platform contact address from settings —
 * never a hardcoded personal address (both call sites used to fall back to
 * one). Honours notifications.emailNotifications, which used to be stored and
 * editable but read by nothing.
 *
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function notifyAdminsByEmail({ subject, html }) {
  const settings = await AdminSettings.getSettings();
  if (settings.notifications?.emailNotifications === false) return { sent: false, reason: 'disabled' };

  const to = process.env.ADMIN_EMAIL || settings.general?.contactEmail;
  if (!to) return { sent: false, reason: 'no_recipient' };

  await sendEmail({ email: to, subject, html });
  return { sent: true };
}

// The "a provider submitted their profile" email, shared by both submission paths.
const notifyProviderSubmitted = (provider) =>
  notifyAdminsByEmail({
    subject: 'New Provider Profile Submitted - Review Required',
    html: `
        <h2>Provider Profile Submitted</h2>
        <p><strong>Name:</strong> ${escapeHtml(provider.fullName)}</p>
        <p><strong>Email:</strong> ${escapeHtml(provider.email)}</p>
        <p><strong>Type:</strong> ${escapeHtml(provider.providerType)}</p>
        <p><strong>City:</strong> ${escapeHtml(provider.city)}</p>
        <p>Please review this provider's profile in the admin dashboard.</p>
      `,
  });

module.exports = { notifyAdminsByEmail, notifyProviderSubmitted, escapeHtml };
