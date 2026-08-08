/**
 * SMTP smoke test — proves mail actually leaves this machine/deployment.
 *
 * This exists because the transporter used to be chosen by NODE_ENV, so any
 * non-production environment silently sent to a dummy Ethereal account and
 * nothing ever reached a real inbox (task.md Issue 4). Run this after setting
 * the EMAIL_* env vars to confirm delivery and get a real messageId back.
 *
 * Run:  node scripts/smoke-auth-email.js [recipient@example.com]
 *   or: npm run smoke:auth-email
 *
 * Defaults to sending to EMAIL_USER (i.e. yourself).
 */
require('dotenv').config();

const {
  sendEmail,
  isSmtpConfigured,
  createTransporter,
} = require('../src/services/emailService');
const { getPublicBaseUrl } = require('../src/utils/publicUrl');

const recipient = process.argv[2] || process.env.EMAIL_USER;

const line = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`);

(async () => {
  console.log('\n=== MetroMatrix SMTP smoke test ===\n');

  line('NODE_ENV', process.env.NODE_ENV || '(unset)');
  line('EMAIL_HOST', process.env.EMAIL_HOST || '(unset)');
  line('EMAIL_PORT', process.env.EMAIL_PORT || '587 (default)');
  line('EMAIL_USER', process.env.EMAIL_USER || '(unset)');
  line('EMAIL_PASS', process.env.EMAIL_PASS ? '(set)' : '(unset)');
  line('EMAIL_FROM', process.env.EMAIL_FROM || '(unset — will use fallback)');
  line('Public base URL', getPublicBaseUrl());
  line('SMTP configured', isSmtpConfigured() ? 'yes' : 'NO — would use Ethereal');
  console.log();

  if (!isSmtpConfigured()) {
    console.error(
      '❌ No SMTP configured. Set EMAIL_HOST/EMAIL_USER/EMAIL_PASS (and EMAIL_FROM)\n' +
      '   in .env locally, or in Vercel → Settings → Environment Variables.\n'
    );
    process.exit(1);
  }

  if (!recipient) {
    console.error('❌ No recipient. Pass one as an argument or set EMAIL_USER.\n');
    process.exit(1);
  }

  // Step 1: prove the credentials are actually accepted before sending.
  try {
    const transporter = createTransporter();
    await transporter.verify();
    console.log('✅ SMTP connection + credentials verified');
  } catch (error) {
    console.error(`❌ SMTP verify failed: ${error.message}`);
    if (/invalid login|username and password not accepted/i.test(error.message)) {
      console.error(
        '   For Gmail this almost always means EMAIL_PASS is the account password.\n' +
        '   It must be a 16-character App Password (Google Account → Security →\n' +
        '   2-Step Verification → App passwords), entered with no spaces.\n'
      );
    }
    process.exit(1);
  }

  // Step 2: actually send.
  try {
    const info = await sendEmail({
      email: recipient,
      subject: 'MetroMatrix SMTP smoke test',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px;">
          <h2 style="color:#6366f1;">SMTP is working</h2>
          <p>This message was sent by <code>scripts/smoke-auth-email.js</code>.</p>
          <p>If you can read this, MetroMatrix can deliver verification and
             password-reset mail from <strong>${process.env.EMAIL_FROM || process.env.EMAIL_USER}</strong>.</p>
          <p style="color:#6b7280;font-size:13px;">
            Verification links on this deployment will point at
            <a href="${getPublicBaseUrl()}">${getPublicBaseUrl()}</a>.
          </p>
        </div>
      `,
    });

    console.log(`✅ Mail sent to ${recipient}`);
    line('messageId', info.messageId);
    if (info.accepted?.length) line('accepted', info.accepted.join(', '));
    if (info.rejected?.length) line('rejected', info.rejected.join(', '));
    if (info.response) line('server response', info.response);
    console.log('\nCheck the inbox (and spam folder) for the message above.\n');
    process.exit(0);
  } catch (error) {
    console.error(`\n❌ Send failed: ${error.message}\n`);
    process.exit(1);
  }
})();
