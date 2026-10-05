const HCNotification = require('../models/HCNotification');

// ============================================================================
// Healthcare notifications — the in-app inbox row AND a push to the phone.
//
// Healthcare used to write inbox rows only: a patient whose appointment was
// confirmed, cancelled or given a prescription found out only by opening the
// app. Every row now also goes out as a push through the realtime service
// (sockets.pushToUser → Expo → FCM), the same path home services use.
//
// `userId` is polymorphic, as it always was: a User id for the patient, the
// doctor's PROVIDER id for doctor-directed rows. The push needs to know which
// collection holds the device tokens, so callers may pass `audience`; when
// they do not, the recipient is resolved (User, then Provider, then a Doctor
// id mapped to its Provider — one call site historically passed that).
// Pushing never throws and never blocks the inbox row.
// ============================================================================

/** Inbox type → push type (the realtime service's PUSHABLE_TYPES allow-list). */
const PUSH_TYPES = {
  appointment_booked: 'appointment_update',
  appointment_confirmed: 'appointment_update',
  appointment_cancelled: 'appointment_update',
  appointment_completed: 'appointment_update',
  appointment_reminder: 'appointment_reminder',
  prescription_ready: 'prescription_ready',
  video_call_starting: 'video_call_starting',
};

/** Where a userId's devices are registered: { pushId, role, audience } or null. */
async function resolveRecipient(userId, audience) {
  if (!userId) return null;
  if (audience === 'patient') return { pushId: userId, role: 'user', audience };
  if (audience === 'doctor') return { pushId: userId, role: 'provider', audience };
  const User = require('../../../models/User');
  const Provider = require('../../../models/Provider');
  if (await User.exists({ _id: userId })) return { pushId: userId, role: 'user', audience: 'patient' };
  if (await Provider.exists({ _id: userId })) return { pushId: userId, role: 'provider', audience: 'doctor' };
  const Doctor = require('../models/Doctor');
  const doctor = await Doctor.findById(userId).select('providerId').lean();
  if (doctor && doctor.providerId) return { pushId: doctor.providerId, role: 'provider', audience: 'doctor' };
  return null;
}

async function pushNotification({ userId, title, message, type, data, audience }) {
  try {
    const pushType = PUSH_TYPES[type];
    if (!pushType) return false;
    const to = await resolveRecipient(userId, audience);
    if (!to) return false;
    const { pushToUser } = require('../../../sockets');
    const payload = { roomType: 'healthcare', audience: to.audience, notificationType: type };
    if (data && data.appointmentId) payload.appointmentId = String(data.appointmentId);
    if (data && data.prescriptionId) payload.prescriptionId = String(data.prescriptionId);
    return await pushToUser(to.pushId, to.role, { type: pushType, title, body: message, data: payload });
  } catch (err) {
    console.error(`[hc-notify] push failed type=${type}: ${err.message}`);
    return false;
  }
}

/**
 * Create a single healthcare notification, and push it.
 * @param {Object} params
 * @param {string} params.userId    - Target user (patient) or doctor's Provider id
 * @param {string} params.title     - Notification title
 * @param {string} params.message   - Notification body
 * @param {string} params.type      - One of the enum types
 * @param {Object} [params.data]    - Optional metadata (appointmentId, etc.)
 * @param {'patient'|'doctor'} [params.audience] - skips recipient resolution
 */
const createNotification = async ({ userId, title, message, type, data = null, audience }) => {
  const doc = await HCNotification.create({ userId, title, message, type, data });
  await pushNotification({ userId, title, message, type, data, audience });
  return doc;
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
    audience: 'doctor',
  });
};

const notifyAppointmentConfirmed = async (patientId, data) => {
  return createNotification({
    userId: patientId,
    title: 'Appointment Confirmed',
    message: 'Your appointment has been confirmed by the doctor.',
    type: 'appointment_confirmed',
    data,
    audience: 'patient',
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
    audience: 'patient',
  });
};

const notifyPrescriptionReady = async (patientId, data) => {
  return createNotification({
    userId: patientId,
    title: 'Prescription Ready',
    message: 'Your doctor has uploaded a prescription for your recent appointment. Tap to view.',
    type: 'prescription_ready',
    data,
    audience: 'patient',
  });
};

const notifyVideoCallStarting = async (patientId, data) => {
  return createNotification({
    userId: patientId,
    title: 'Video Call Starting Soon',
    message: 'Your video consultation starts in 5 minutes. Please join the call.',
    type: 'video_call_starting',
    data,
    audience: 'patient',
  });
};

module.exports = {
  createNotification,
  resolveRecipient,
  pushNotification,
  PUSH_TYPES,
  createBulkNotifications,
  notifyAppointmentBooked,
  notifyAppointmentConfirmed,
  notifyAppointmentCancelled,
  notifyAppointmentReminder,
  notifyPrescriptionReady,
  notifyVideoCallStarting,
};
