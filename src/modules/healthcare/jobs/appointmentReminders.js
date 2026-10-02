/**
 * Local-only scheduler for appointment reminders (`npm start`).
 *
 * Production never runs this file — Vercel has no long-lived process. There,
 * POST /api/internal/scheduler/tick does the same work (services/
 * reminderService.js), called by the realtime dyno every few minutes. Both
 * paths claim each appointment atomically, so running both never double-sends.
 */
const cron = require('node-cron');
const { runAppointmentReminders, runVideoReminders } = require('../services/reminderService');

cron.schedule('*/5 * * * *', async () => {
  try {
    const [hour, video] = await Promise.all([runAppointmentReminders(), runVideoReminders()]);
    if (hour || video) console.log(`[HC Jobs] reminders sent: ${hour} hour, ${video} video`);
  } catch (error) {
    console.error('[HC Jobs] reminder sweep error:', error.message);
  }
});

console.log('✅ Healthcare reminder job registered (local only)');
