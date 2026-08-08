/**
 * The backend's own public origin — the base for every link we email out.
 *
 * This matters more than it looks. The `/verify-email` and `/reset-password`
 * pages are served by THIS Express app, so the link in an email has to point
 * at the backend's public host, not the mobile app and not a stale host.
 *
 * The old code repeated `process.env.API_URL || process.env.CLIENT_URL ||
 * 'http://localhost:5000'` in three places (registerUser, registerProvider,
 * EmailVerificationService). On the deployed backend those still pointed at
 * the retired Heroku dyno, so every verification link opened Heroku's
 * "There's nothing here" page and no account ever verified (task.md Issue 4,
 * root cause B).
 *
 * Set API_URL in Vercel to the backend's own origin, with no /api suffix:
 *   API_URL=https://metro-matrix-backend.vercel.app
 */

let warnedAboutHeroku = false;
let warnedAboutMissing = false;

const DEFAULT_BASE_URL = 'http://localhost:5000';

/** Strip a trailing slash and any trailing /api so callers can always append a path. */
const normalize = (raw) => raw.trim().replace(/\/+$/, '').replace(/\/api$/i, '');

/**
 * @returns {string} the backend's public origin, without a trailing slash.
 */
const getPublicBaseUrl = () => {
  const configured = process.env.API_URL || process.env.CLIENT_URL;

  if (!configured) {
    if (!warnedAboutMissing) {
      warnedAboutMissing = true;
      console.warn(
        `⚠️  API_URL is not set — emailed verification/reset links will point at ${DEFAULT_BASE_URL}, ` +
        'which is unreachable from a real inbox. Set API_URL to this backend\'s public origin ' +
        '(e.g. https://metro-matrix-backend.vercel.app).'
      );
    }
    return DEFAULT_BASE_URL;
  }

  const baseUrl = normalize(configured);

  // The single most likely misconfiguration on this project: the Vercel
  // deployment still carrying the old Heroku host. Say so loudly, every
  // boot, rather than shipping dead links silently.
  if (/herokuapp\.com/i.test(baseUrl) && !warnedAboutHeroku) {
    warnedAboutHeroku = true;
    console.warn(
      `⚠️  API_URL/CLIENT_URL points at a Heroku host (${baseUrl}). MetroMatrix now runs on Vercel; ` +
      'emailed links to this host will 404. Update API_URL in Vercel → Settings → Environment Variables ' +
      'to https://metro-matrix-backend.vercel.app and redeploy.'
    );
  }

  return baseUrl;
};

/**
 * Build an absolute URL on the backend's public origin.
 * @param {string} path e.g. '/verify-email'
 * @param {Record<string, string>} [query]
 */
const buildPublicUrl = (path, query) => {
  const base = getPublicBaseUrl();
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
  return `${base}${suffix}${qs}`;
};

/** Absolute URL of the email-verification page for a given token. */
const buildVerificationUrl = (token, type = 'user') =>
  buildPublicUrl('/verify-email', { token, type });

module.exports = {
  getPublicBaseUrl,
  buildPublicUrl,
  buildVerificationUrl,
  DEFAULT_BASE_URL,
};
