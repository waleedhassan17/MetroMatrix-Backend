/**
 * Auth end-to-end smoke test (task.md runbook).
 *
 * Proves, against a running backend, the flow the five reported bugs broke:
 *
 *   User:     register → [you click the emailed link] → login → login AGAIN
 *             (the double-hash bug only shows on the second login) →
 *             forgot-password → verify OTP → reset → new password works and
 *             the old one does not.
 *   Provider: register → [click link] → login gates (EMAIL_NOT_VERIFIED →
 *             ACCOUNT_NOT_APPROVED → 200) → login twice.
 *   Always:   forgot-password for an unknown email returns the same generic
 *             success, and /auth/health reports a non-Heroku API_URL.
 *
 * It pauses where a human is genuinely required (clicking the link in the
 * inbox, reading an OTP) rather than pretending to automate it.
 *
 * Run:
 *   API_URL=https://metro-matrix-backend.vercel.app npm run smoke:auth
 *   API_URL=http://localhost:5000 npm run smoke:auth
 *
 * Flags:
 *   --user-email=...      (default konta6337@gmail.com)
 *   --password=...        (default 12345678)
 *   --provider-email=...  run the provider flow too
 *   --skip-reset          stop before the password-reset section
 *   --yes                 don't pause; skips the steps needing a human
 */
require('dotenv').config();
const axios = require('axios');
const readline = require('readline');

const BASE = (process.env.API_URL || 'http://localhost:5000').replace(/\/+$/, '').replace(/\/api$/i, '');
const api = axios.create({ baseURL: `${BASE}/api`, validateStatus: () => true, timeout: 30000 });

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const USER_EMAIL = arg('user-email', 'konta6337@gmail.com');
const PASSWORD = arg('password', '12345678');
const NEW_PASSWORD = arg('new-password', 'NewPass!2026');
const PROVIDER_EMAIL = arg('provider-email', null);
const NON_EXISTENT = `definitely-not-registered-${Date.now()}@example.com`;
const NON_INTERACTIVE = flag('yes');

let passed = 0;
let failed = 0;
let skipped = 0;

const step = (name, ok, detail = '') => {
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (ok) passed += 1;
  else failed += 1;
  return ok;
};
const skip = (name, why) => {
  console.log(`[SKIP] ${name}${why ? ` — ${why}` : ''}`);
  skipped += 1;
};
const section = (title) => console.log(`\n──── ${title} ────`);

const ask = (question) =>
  new Promise((resolve) => {
    if (NON_INTERACTIVE) return resolve('');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

(async () => {
  console.log(`\n=== MetroMatrix auth smoke test ===\nTarget: ${BASE}\n`);

  // ---------------------------------------------------------------- health
  section('Config health');
  const health = await api.get('/auth/health');
  if (health.status !== 200) {
    step('GET /api/auth/health', false, `status ${health.status}`);
    console.error('\nCannot reach the backend. Is it running / is API_URL right?\n');
    process.exit(1);
  }
  console.log(JSON.stringify(health.data, null, 2));
  step('GET /api/auth/health', true);
  step(
    'API_URL is not the retired Heroku host',
    health.data.publicBaseUrlLooksStale === false,
    `publicBaseUrl=${health.data.publicBaseUrl}`
  );
  step(
    'SMTP is configured (verification mail can actually send)',
    health.data.email?.smtpConfigured === true,
    health.data.email?.smtpConfigured ? `host=${health.data.email.host}` : 'set EMAIL_HOST/EMAIL_USER/EMAIL_PASS'
  );

  // ------------------------------------------------- anti-enumeration first
  // Cheap, needs no state, and proves Issue 3 independently of the rest.
  section('Password reset does not disclose which emails exist (Issue 3)');
  const unknown = await api.post('/auth/forgot-password', { email: NON_EXISTENT });
  step(
    'unknown email returns 200, not 404',
    unknown.status === 200,
    `status ${unknown.status}`
  );
  step(
    'unknown email returns the generic message',
    /if an account exists/i.test(unknown.data?.message || ''),
    JSON.stringify(unknown.data?.message)
  );

  // --------------------------------------------------------------- register
  section(`User registration — ${USER_EMAIL}`);
  const register = await api.post('/auth/register', {
    fullName: 'Smoke Test User',
    phoneNumber: '03001234567',
    email: USER_EMAIL,
    password: PASSWORD,
  });

  if (register.status === 201) {
    step('POST /auth/register → 201', true, register.data?.message);
  } else if (
    register.status === 400 &&
    /already/i.test(register.data?.message || '')
  ) {
    step('POST /auth/register', true, `already registered/pending — continuing (${register.data.message})`);
  } else {
    step('POST /auth/register', false, `status ${register.status}: ${JSON.stringify(register.data)}`);
  }

  console.log(
    `\n  ➜ Check ${USER_EMAIL} for the verification mail (from ${health.data.email?.from || 'EMAIL_FROM'}).\n` +
    `    The link must open ${health.data.publicBaseUrl}/verify-email — NOT a herokuapp.com page.\n`
  );
  if (NON_INTERACTIVE) {
    skip('email verification', '--yes given; a human must click the link');
  } else {
    await ask('  Press Enter once you have clicked the verification link... ');
  }

  // ------------------------------------------------------------ login twice
  section('Login twice (proves the double-hash bug is gone — Issue 1)');
  const login1 = await api.post('/auth/login', { email: USER_EMAIL, password: PASSWORD });
  const firstOk = step(
    'first login → 200 + tokens',
    login1.status === 200 && Boolean(login1.data?.accessToken),
    login1.status === 200 ? '' : `status ${login1.status}: ${JSON.stringify(login1.data?.message)}`
  );

  if (firstOk) {
    const login2 = await api.post('/auth/login', { email: USER_EMAIL, password: PASSWORD });
    step(
      'SECOND login also succeeds (the actual regression)',
      login2.status === 200 && Boolean(login2.data?.accessToken),
      login2.status === 200 ? '' : `status ${login2.status}: ${JSON.stringify(login2.data?.message)}`
    );

    const login3 = await api.post('/auth/login', { email: USER_EMAIL, password: PASSWORD });
    step(
      'third login also succeeds',
      login3.status === 200,
      login3.status === 200 ? '' : `status ${login3.status}`
    );

    step(
      'expiresIn reflects the real JWT_EXPIRE, not a hardcoded 30 days',
      login1.data.expiresIn !== 30 * 24 * 60 * 60 * 1000,
      `expiresIn=${login1.data.expiresIn}ms`
    );
  } else {
    skip('repeat logins', 'first login failed — verify the email first');
  }

  // ------------------------------------------------------------ reset flow
  if (flag('skip-reset')) {
    skip('password reset flow', '--skip-reset given');
  } else if (!firstOk) {
    skip('password reset flow', 'account not usable yet');
  } else {
    section('Password reset (Issue 3 happy path)');
    const forgot = await api.post('/auth/forgot-password', { email: USER_EMAIL });
    step(
      'POST /auth/forgot-password → 200 generic success',
      forgot.status === 200 && /if an account exists/i.test(forgot.data?.message || ''),
      `status ${forgot.status}: ${JSON.stringify(forgot.data?.message)}`
    );

    step(
      'real and unknown emails give identical replies',
      forgot.data?.message === unknown.data?.message && forgot.status === unknown.status,
      'same status + message'
    );

    const otp = await ask(`  Enter the 6-digit OTP sent to ${USER_EMAIL} (blank to skip): `);

    if (!otp) {
      skip('OTP verification + reset', 'no OTP supplied');
    } else {
      const verify = await api.post('/auth/verify-reset-otp', { email: USER_EMAIL, otp });
      const resetToken = verify.data?.resetToken;
      const verifiedOk = step(
        'POST /auth/verify-reset-otp → resetToken',
        verify.status === 200 && Boolean(resetToken),
        verify.status === 200 ? '' : `status ${verify.status}: ${JSON.stringify(verify.data?.message)}`
      );

      if (verifiedOk) {
        const reset = await api.post('/auth/reset-password', {
          resetToken,
          password: NEW_PASSWORD,
        });
        step(
          'POST /auth/reset-password → 200',
          reset.status === 200,
          reset.status === 200 ? '' : `status ${reset.status}: ${JSON.stringify(reset.data?.message)}`
        );

        const newLogin = await api.post('/auth/login', { email: USER_EMAIL, password: NEW_PASSWORD });
        step(
          'login with the NEW password succeeds',
          newLogin.status === 200,
          newLogin.status === 200 ? '' : `status ${newLogin.status}`
        );

        const oldLogin = await api.post('/auth/login', { email: USER_EMAIL, password: PASSWORD });
        step(
          'login with the OLD password is rejected',
          oldLogin.status === 401,
          `status ${oldLogin.status}`
        );

        const newLogin2 = await api.post('/auth/login', { email: USER_EMAIL, password: NEW_PASSWORD });
        step(
          'new password still works on a second login (no re-hash)',
          newLogin2.status === 200,
          `status ${newLogin2.status}`
        );

        // Sessions minted before the reset must be dead.
        if (login1.data?.refreshToken) {
          const staleRefresh = await api.post('/auth/refresh', {
            refreshToken: login1.data.refreshToken,
          });
          step(
            'refresh token from before the reset is invalidated',
            staleRefresh.status === 401,
            `status ${staleRefresh.status}`
          );
        }

        console.log(`\n  ⚠️  Password for ${USER_EMAIL} is now "${NEW_PASSWORD}".\n`);
      }
    }
  }

  // -------------------------------------------------------- provider flow
  if (!PROVIDER_EMAIL) {
    skip('provider flow', 'pass --provider-email=... to run it');
  } else {
    section(`Provider flow — ${PROVIDER_EMAIL}`);
    const preg = await api.post('/auth/provider/register', {
      fullName: 'Smoke Test Provider',
      phoneNumber: '03009876543',
      email: PROVIDER_EMAIL,
      password: PASSWORD,
    });
    if (preg.status === 201) {
      step('POST /auth/provider/register → 201', true, `emailSent=${preg.data?.emailSent}`);
    } else if (preg.status === 409) {
      step('POST /auth/provider/register', true, 'already exists — continuing');
    } else {
      step('POST /auth/provider/register', false, `status ${preg.status}: ${JSON.stringify(preg.data)}`);
    }

    // Gate 1: unverified email.
    const unverified = await api.post('/auth/provider/login', {
      email: PROVIDER_EMAIL,
      password: PASSWORD,
    });
    if (unverified.data?.error === 'EMAIL_NOT_VERIFIED') {
      step('unverified provider login → 403 EMAIL_NOT_VERIFIED', unverified.status === 403);
      console.log(`\n  ➜ Click the verification link sent to ${PROVIDER_EMAIL}.\n`);
      if (NON_INTERACTIVE) {
        skip('provider email verification', '--yes given');
      } else {
        await ask('  Press Enter once verified... ');
      }
    } else {
      step('provider email gate reachable', true, `already past it (${unverified.data?.error || unverified.status})`);
    }

    // Gate 2: verified but not admin-approved.
    const unapproved = await api.post('/auth/provider/login', {
      email: PROVIDER_EMAIL,
      password: PASSWORD,
    });
    if (unapproved.data?.error === 'ACCOUNT_NOT_APPROVED') {
      step('verified-but-unapproved → 403 ACCOUNT_NOT_APPROVED', unapproved.status === 403);
      console.log('\n  ➜ Approve this provider in the admin dashboard.\n');
      if (NON_INTERACTIVE) {
        skip('admin approval', '--yes given');
      } else {
        await ask('  Press Enter once approved... ');
      }
    } else if (unapproved.status === 200) {
      step('provider already approved', true);
    } else {
      step('provider approval gate', true, `state: ${unapproved.data?.error || unapproved.status}`);
    }

    // Gate 3: approved → tokens, twice.
    const plogin1 = await api.post('/auth/provider/login', { email: PROVIDER_EMAIL, password: PASSWORD });
    const pOk = step(
      'approved provider login → 200 + tokens',
      plogin1.status === 200 && Boolean(plogin1.data?.accessToken),
      plogin1.status === 200 ? '' : `status ${plogin1.status}: ${plogin1.data?.error || ''}`
    );
    if (pOk) {
      const plogin2 = await api.post('/auth/provider/login', { email: PROVIDER_EMAIL, password: PASSWORD });
      step(
        'provider SECOND login also succeeds (double-hash fix)',
        plogin2.status === 200,
        `status ${plogin2.status}`
      );
    }
  }

  // ------------------------------------------------------------ debug gate
  section('Debug routes are not publicly reachable (P3)');
  const manual = await api.post('/auth/manual-verify', { email: USER_EMAIL });
  step(
    'POST /auth/manual-verify is not open to the public',
    manual.status === 404 || manual.status === 401 || manual.status === 403,
    `status ${manual.status}`
  );

  // ----------------------------------------------------------------- summary
  console.log(`\n──── Summary ────`);
  console.log(`PASS ${passed}   FAIL ${failed}   SKIP ${skipped}\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error('\n💥 Smoke test crashed:', error.message);
  process.exit(1);
});
