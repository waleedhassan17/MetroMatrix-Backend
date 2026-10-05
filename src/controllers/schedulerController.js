/**
 * POST|GET /api/internal/scheduler/tick — everything time-driven, in one call.
 *
 * Vercel is serverless: no process stays up to run timers, and Hobby-plan
 * Vercel Cron fires at most once a day. So the realtime service (a Heroku dyno
 * that never sleeps) calls this every ~5 minutes, and a GitHub Actions
 * workflow calls it every 15 as a watchdog. Every task below is idempotent —
 * each send is claimed atomically — so overlapping or duplicate ticks are safe.
 *
 * Tasks run side by side, each capped well inside Vercel's 30 s limit; one
 * failing or slow task never stops the others. Auth: x-internal-key or the
 * Vercel Cron bearer (gateway/internalAuth.js).
 */
const asyncHandler = require('express-async-handler');
const { withRedis, k } = require('../lib/redis');

const TASK_TIMEOUT_MS = 20000;
const EXPIRY_EVERY_SEC = 30 * 60;

function capped(name, fn) {
  return Promise.race([
    Promise.resolve().then(fn),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} timed out`)), TASK_TIMEOUT_MS)),
  ]);
}

/** Run the expiry sweep at most every 30 minutes (every tick if Redis is down). */
async function expiryDue() {
  const claimed = await withRedis((r) => r.set(k('sched', 'expiry'), '1', { nx: true, ex: EXPIRY_EVERY_SEC }), 'no-redis');
  return claimed !== null;
}

const tick = asyncHandler(async (req, res) => {
  const started = Date.now();
  const now = new Date();
  const tasks = {
    appointmentReminders: () => require('../modules/healthcare/services/reminderService').runAppointmentReminders(now),
    videoReminders: () => require('../modules/healthcare/services/reminderService').runVideoReminders(now),
    bookingReminders: () => require('../modules/homeservice/services/bookingReminderService').runBookingReminders(now),
    bookingExpiry: async () => {
      if (!(await expiryDue())) return 'skipped';
      return require('../modules/homeservice/services/expiryService').expireStale({}, now);
    },
  };

  const names = Object.keys(tasks);
  const results = await Promise.allSettled(names.map((n) => capped(n, tasks[n])));
  const summary = {};
  results.forEach((r, i) => {
    summary[names[i]] = r.status === 'fulfilled' ? r.value : { error: r.reason && r.reason.message };
    if (r.status === 'rejected') console.error(`[scheduler] ${names[i]} failed: ${r.reason && r.reason.message}`);
  });
  console.log(JSON.stringify({ t: 'tick', ms: Date.now() - started, ...summary }));
  res.json({ success: true, data: { ranAt: now.toISOString(), ms: Date.now() - started, tasks: summary } });
});

module.exports = { tick };
