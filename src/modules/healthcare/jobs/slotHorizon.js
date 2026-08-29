/**
 * Scheduled job: keep every doctor's bookable horizon populated.
 *
 * WHY THIS JOB EXISTS
 * -------------------
 * Slot generation was one-shot. The doctor app published a fixed 30-day window
 * and nothing ever extended it, so a doctor set their availability once and
 * roughly a month later it silently ran out — no error, no warning, just a
 * calendar that stopped having anything in it.
 *
 * That is how production reached the state this job was written to fix: all 530
 * slots ran 2026-07-08 to 2026-08-27 while the date was 2026-08-29, so every
 * one of thirteen doctors had zero bookable slots and no patient could book
 * anything. Fixing generation alone would have reproduced that a month later.
 *
 * Runs daily rather than hourly: the horizon is measured in weeks, so there is
 * nothing to gain from checking more often, and generation touches every active
 * doctor. Generation is idempotent, so a missed run costs nothing and a double
 * run inserts nothing.
 */
const cron = require('node-cron');
const { refreshAllDoctors, HORIZON_DAYS } = require('../services/slotGenerationService');

// 03:20 daily — off the hour, and outside clinic hours in Asia/Karachi so a
// long run cannot contend with booking traffic.
const SCHEDULE = process.env.SLOT_HORIZON_CRON || '20 3 * * *';

async function run(trigger) {
  const started = Date.now();
  try {
    const result = await refreshAllDoctors();
    console.log(
      `[slots] horizon refresh (${trigger}): ${result.created} slot(s) created for ` +
        `${result.touched}/${result.doctors} doctor(s), horizon ${HORIZON_DAYS}d, ` +
        `${Date.now() - started}ms`
    );
  } catch (e) {
    console.error(`[slots] horizon refresh failed (${trigger}): ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// IN PRODUCTION THIS CRON DOES NOT FIRE, AND THAT IS EXPECTED.
//
// vercel.json rewrites every request to api/index.js; server.js — which is what
// registers this module — only runs under `npm start` locally. A serverless
// function has no long-lived process for node-cron to tick in. This repo has
// been bitten by exactly that before: the Socket.IO layer was attached in
// server.js and was therefore a no-op in production for months (see the note
// at src/server.js).
//
// So the scheduler below is for LOCAL DEVELOPMENT only. Production is driven by
// Vercel Cron hitting POST /api/internal/slots/refresh-horizon on a schedule
// declared in vercel.json — same work, same service, triggered from outside.
// ---------------------------------------------------------------------------
if (process.env.VERCEL !== '1') {
  cron.schedule(SCHEDULE, () => run('cron'));

  // Also shortly after boot: a process that was down through the scheduled time
  // would otherwise wait a full day, and the entire point is that availability
  // must never lapse quietly.
  const bootTimer = setTimeout(() => run('boot'), 30_000);
  if (bootTimer.unref) bootTimer.unref();
}

module.exports = { run };
