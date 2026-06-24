const HCNotification = require('../models/HCNotification');

/**
 * Create a single healthcare notification.
 * @param {Object} params
 * @param {string} params.userId    - Target user ID
 * @param {string} params.title     - Notification title
 * @param {string} params.message   - Notification body
 * @param {string} params.type      - One of the enum types
 * @param {Object} [params.data]    - Optional metadata (appointmentId, etc.)
 */
const createNotification = async ({ userId, title, message, type, data = null }) => {
  return HCNotification.create({ userId, title, message, type, data });
};

/**
 * Create notifications for multiple users at once.
 */
const createBulkNotifications = async (userIds, title, message, type, data = null) => {
  const docs = userIds.map((id) => ({ userId: id, title, message, type, data }));
  return HCNotification.insertMany(docs);
};

// ─── Convenience helpers for common notifications ───

const notifyAppointmentBooked = async (patientId, doctorUserId, data) => {
  return createNotification({
    userId: doctorUserId,
    title: 'New Appointment',
    message: `${data.patientName || 'A patient'} has booked a ${data.type || ''} appointment for ${
      data.date ? new Date(data.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'an upcoming date'
    } at ${data.startTime || ''}`.trim(),
    type: 'appointment_booked',
    data,
  });
};

const notifyAppointmentConfirmed = async (patientId, data) => {
  return createNotification({
    userId: patientId,
    title: 'Appointment Confirmed',
    message: 'Your appointment has been confirmed by the doctor.',
    type: 'appointment_confirmed',
    data,
  });
};

const notifyAppointmentCancelled = async (targetUserId, data) => {
  return createNotification({
    userId: targetUserId,
    title: 'Appointment Cancelled',
    message: data.reason
      ? `An appointment was cancelled. Reason: ${data.reason}`
      : 'An appointment has been cancelled.',
    type: 'appointment_cancelled',
    data,
  });
};

const notifyAppointmentReminder = async (patientId, data) => {
  return createNotification({
    userId: patientId,
    title: 'Appointment Reminder',
    message: `Your appointment is in about 1 hour at ${data.startTime || ''}. ${
      data.type === 'video' ? 'Please be ready for the video call.' : `Please arrive at ${data.clinicName || 'the clinic'} on time.`
    }`.trim(),
    type: 'appointment_reminder',
    data,
  });
};

const notifyPrescriptionReady = async (patientId, data) => {
  return createNotification({
    userId: patientId,
    title: 'Prescription Ready',
    message: 'Your doctor has uploaded a prescription for your recent appointment. Tap to view.',
    type: 'prescription_ready',
    data,
  });
};

const notifyVideoCallStarting = async (patientId, data) => {
  return createNotification({
    userId: patientId,
    title: 'Video Call Starting Soon',
    message: 'Your video consultation starts in 5 minutes. Please join the call.',
    type: 'video_call_starting',
    data,
  });
};

module.exports = {
  createNotification,
  createBulkNotifications,
  notifyAppointmentBooked,
  notifyAppointmentConfirmed,
  notifyAppointmentCancelled,
  notifyAppointmentReminder,
  notifyPrescriptionReady,
  notifyVideoCallStarting,
};
