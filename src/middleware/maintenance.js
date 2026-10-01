const named = require('../utils/named');
const logger = require('../utils/logger');
const { getAdminSettings } = require('../services/settingsCache');
const { isAdminRequest, pathOf, startsWithSegment } = require('../utils/adminScope');

/**
 * general.maintenanceMode: while on, the user/provider API answers 503 with
 * the configured message. Admins keep working (so they can turn it off),
 * and so do health checks, scheduled jobs and the Stripe webhook (money that
 * already moved must still be recorded).
 *
 * The setting is read through a 30 s cache, so switching it takes effect on
 * every serverless instance within half a minute.
 */
const ALWAYS_OPEN = ['/api/internal', '/api/wallet/webhook', '/api/admin/provider-submissions'];
const DEFAULT_MESSAGE = 'MetroMatrix is down for scheduled maintenance. Please try again shortly.';

const maintenance = named('maintenance', async (req, res, next) => {
  const path = pathOf(req);
  if (!path.startsWith('/api/') || isAdminRequest(req) || ALWAYS_OPEN.some((p) => startsWithSegment(path, p))) {
    return next();
  }
  let general;
  try {
    general = (await getAdminSettings()).general || {};
  } catch (err) {
    // Can't read settings (DB trouble): don't add a second outage on top.
    (req.log || logger).warn({ err }, 'maintenance check skipped — settings unavailable');
    return next();
  }
  if (!general.maintenanceMode) return next();

  const message = general.maintenanceMessage || DEFAULT_MESSAGE;
  res.set('Retry-After', '300');
  return res.status(503).json({ success: false, error: message, message, code: 'MAINTENANCE', maintenance: true });
});

module.exports = maintenance;
