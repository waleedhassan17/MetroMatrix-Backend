/**
 * Scheduled Healthcare Jobs
 *
 * Job 1: Appointment Reminders — every 5 minutes
 *   Sends a notification ~1 hour before confirmed appointments.
 *
 * Job 2: Video Call Reminders — every 5 minutes
 *   Sends a notification ~5 minutes before video appointments.
 */
const cron = require('node-cron');
const Appointment = require('../models/Appointment');
const Slot = require('../models/Slot');
const Doctor = require('../models/Doctor');
const Clinic = require('../models/Clinic');
const notificationService = require('../services/notificationService');

/**
 * Parse "HH:mm" time string to { hours, minutes }.
 */
const parseTime = (timeStr) => {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return { hours, minutes };
};

/**
 * Convert "HH:mm" string to total minutes since midnight.
 */
const timeToMinutes = (timeStr) => {
  const { hours, minutes } = parseTime(timeStr);
  return hours * 60 + minutes;
};

// ═══════════════════════════════════════════════════════
//  JOB 1: Appointment Reminders (1 hour before)
//  Runs every 5 minutes
// ═══════════════════════════════════════════════════════
cron.schedule('*/5 * * * *', async () => {
  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    // Target window: 55–65 minutes from now (1 hour ± 5 min)
    const targetMin = nowMinutes + 55;
    const targetMax = nowMinutes + 65;

    // Find confirmed appointments for today that haven't had a reminder sent
    const appointments = await Appointment.find({
      status: 'confirmed',
      reminderSentAt: null,
    })
      .populate('slotId', 'date startTime type clinicId')
      .populate({
        path: 'doctorId',
        populate: { path: 'userId', select: 'fullName displayName' },
      })
      .lean();

    let sentCount = 0;

    for (const appt of appointments) {
      if (!appt.slotId || !appt.slotId.date || !appt.slotId.startTime) continue;

      // Check if slot date is today
      const slotDate = new Date(appt.slotId.date);
      slotDate.setHours(0, 0, 0, 0);
      if (slotDate.getTime() !== today.getTime()) continue;

      // Check if slot startTime falls in the target window
      const slotMinutes = timeToMinutes(appt.slotId.startTime);
      if (slotMinutes < targetMin || slotMinutes > targetMax) continue;

      // Fetch clinic name for the notification message
      let clinicName = '';
      if (appt.slotId.clinicId) {
        const clinic = await Clinic.findById(appt.slotId.clinicId).select('name').lean();
        clinicName = clinic?.name || '';
      }

      const doctorName = appt.doctorId?.userId?.displayName
        || appt.doctorId?.userId?.fullName
        || 'your doctor';

      // Send reminder notification to patient
      await notificationService.notifyAppointmentReminder(appt.patientId, {
        appointmentId: appt._id,
        doctorName,
        startTime: appt.slotId.startTime,
        type: appt.slotId.type || appt.type,
        clinicName,
      });

      // Mark reminder as sent
      await Appointment.findByIdAndUpdate(appt._id, { reminderSentAt: new Date() });
      sentCount++;
    }

    if (sentCount > 0) {
      console.log(`[HC Jobs] Sent ${sentCount} appointment reminder(s)`.cyan);
    }
  } catch (error) {
    console.error('[HC Jobs] Appointment reminder error:', error.message);
  }
});

// ═══════════════════════════════════════════════════════
//  JOB 2: Video Call Reminders (5 minutes before)
//  Runs every 5 minutes
// ═══════════════════════════════════════════════════════
cron.schedule('*/5 * * * *', async () => {
  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    // Target window: 3–8 minutes from now (5 min ± ~2.5 min)
    const targetMin = nowMinutes + 3;
    const targetMax = nowMinutes + 8;

    // Find confirmed video appointments for today
    const appointments = await Appointment.find({
      status: 'confirmed',
      type: 'video',
    })
      .populate('slotId', 'date startTime type')
      .populate({
        path: 'doctorId',
        populate: { path: 'userId', select: 'fullName displayName' },
      })
      .lean();

    let sentCount = 0;

    for (const appt of appointments) {
      if (!appt.slotId || !appt.slotId.date || !appt.slotId.startTime) continue;

      // Check if slot date is today
      const slotDate = new Date(appt.slotId.date);
      slotDate.setHours(0, 0, 0, 0);
      if (slotDate.getTime() !== today.getTime()) continue;

      // Check if slot startTime falls in the 5-minute target window
      const slotMinutes = timeToMinutes(appt.slotId.startTime);
      if (slotMinutes < targetMin || slotMinutes > targetMax) continue;

      // Avoid duplicate video call reminders — check if one was already sent
      const existing = await require('../models/HCNotification').findOne({
        userId: appt.patientId,
        type: 'video_call_starting',
        'data.appointmentId': appt._id,
      });
      if (existing) continue;

      const doctorName = appt.doctorId?.userId?.displayName
        || appt.doctorId?.userId?.fullName
        || 'Your doctor';

      // Notify patient
      await notificationService.notifyVideoCallStarting(appt.patientId, {
        appointmentId: appt._id,
        doctorName,
        startTime: appt.slotId.startTime,
      });

      sentCount++;
    }

    if (sentCount > 0) {
      console.log(`[HC Jobs] Sent ${sentCount} video call reminder(s)`.cyan);
    }
  } catch (error) {
    console.error('[HC Jobs] Video call reminder error:', error.message);
  }
});

console.log('✅ Healthcare cron jobs registered'.green);
