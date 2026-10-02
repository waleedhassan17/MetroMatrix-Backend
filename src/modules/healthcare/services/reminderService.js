/**
 * Appointment reminders — "in about an hour" and, for video, "in 5 minutes".
 *
 * The old node-cron job only ran under `npm start`, which production (Vercel,
 * serverless) never does — so no reminder was ever sent. It also compared
 * slot times with the SERVER's local clock, which is UTC on any host, so it
 * would have fired five hours off. This works on `Appointment.startUtc` (the
 * real instant) and is triggered by POST /api/internal/scheduler/tick, which
 * the realtime dyno calls every few minutes (GitHub Actions as a watchdog).
 *
 * Exactly-once: each appointment is CLAIMED with a conditional update
 * (reminderSentAt / videoReminderSentAt: null → now) before anything is sent,
 * so overlapping ticks, retries and a late watchdog can never double-send.
 * The windows are generous (70 / 10 minutes) because a scheduler can run late.
 */
const Appointment = require('../models/Appointment');
const notificationService = require('./notificationService');

const HOUR_WINDOW_MIN = 70;
const VIDEO_WINDOW_MIN = 10;
const BATCH = 200;

function timeLabel(appt) {
  if (appt.startTime) return appt.startTime;
  try {
    return new Date(appt.startUtc).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: appt.timezone || 'Asia/Karachi',
    });
  } catch (e) {
    return '';
  }
}

async function claim(appt, field, now) {
  const won = await Appointment.updateOne(
    { _id: appt._id, status: 'confirmed', [field]: null },
    { $set: { [field]: now } }
  );
  return won.modifiedCount === 1;
}

/** Confirmed appointments starting within the next ~hour. @returns number sent */
async function runAppointmentReminders(now = new Date()) {
  const due = await Appointment.find({
    status: 'confirmed',
    reminderSentAt: null,
    startUtc: { $gt: now, $lte: new Date(now.getTime() + HOUR_WINDOW_MIN * 60000) },
  })
    .select('_id patientId doctorId clinicId type startUtc startTime timezone')
    .populate('clinicId', 'name')
    .limit(BATCH)
    .lean();

  let sent = 0;
  for (const appt of due) {
    if (!(await claim(appt, 'reminderSentAt', now))) continue;
    try {
      await notificationService.notifyAppointmentReminder(appt.patientId, {
        appointmentId: appt._id,
        startTime: timeLabel(appt),
        type: appt.type,
        clinicName: appt.clinicId && appt.clinicId.name ? appt.clinicId.name : '',
      });
      sent += 1;
    } catch (e) {
      console.error(`[reminders] appointment=${appt._id}: ${e.message}`);
    }
  }
  return sent;
}

/** Video consultations starting within ~5–10 minutes. @returns number sent */
async function runVideoReminders(now = new Date()) {
  const due = await Appointment.find({
    status: 'confirmed',
    type: 'video',
    videoReminderSentAt: null,
    startUtc: { $gt: now, $lte: new Date(now.getTime() + VIDEO_WINDOW_MIN * 60000) },
  })
    .select('_id patientId startUtc startTime timezone')
    .limit(BATCH)
    .lean();

  let sent = 0;
  for (const appt of due) {
    if (!(await claim(appt, 'videoReminderSentAt', now))) continue;
    try {
      await notificationService.notifyVideoCallStarting(appt.patientId, {
        appointmentId: appt._id,
        startTime: timeLabel(appt),
      });
      sent += 1;
    } catch (e) {
      console.error(`[reminders] video appointment=${appt._id}: ${e.message}`);
    }
  }
  return sent;
}

module.exports = { runAppointmentReminders, runVideoReminders, HOUR_WINDOW_MIN, VIDEO_WINDOW_MIN };
