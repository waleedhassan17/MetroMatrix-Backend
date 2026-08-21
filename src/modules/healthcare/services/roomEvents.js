// ============================================================================
// Healthcare → realtime room events.
//
// Healthcare emitted NOTHING before this: a grep for socket usage across
// src/modules/healthcare/ returned zero hits, so appointment confirmations,
// cancellations, reschedules, payments and video-call transitions reached a
// connected patient or doctor only when they happened to refetch.
//
// A healthcare room IS the Appointment _id — the same id the patient and the
// doctor already join for chat and calling (see the realtime service's
// utils/access.js, which resolves either an HSBooking or an Appointment and
// performs the Provider→Doctor identity hop). So these events land for BOTH
// parties with no extra addressing.
//
// PUBLISH AFTER COMMIT, NEVER INSIDE A TRANSACTION. Several of these mutations
// run in a mongoose session; announcing from inside one means a later rollback
// leaves every client showing a change that never persisted.
//
// Every helper is best-effort and self-logging: a failure here must never fail
// the request that triggered it.
// ============================================================================

const { emitToRoom } = require('../../../sockets');

/**
 * @param {string|ObjectId} appointmentId  doubles as the room id
 * @param {string} status                  pending | confirmed | cancelled | completed | no_show
 * @param {object} extra                   optional context (reason, actor, …)
 */
async function emitAppointmentStatus(appointmentId, status, extra = {}) {
  if (!appointmentId || !status) return false;
  return emitToRoom(appointmentId, 'appointment_status_changed', {
    appointmentId: String(appointmentId),
    roomId: String(appointmentId),
    status,
    changedAt: new Date().toISOString(),
    ...extra,
  });
}

/** @param {string} status  unpaid | paid | refunded */
async function emitPaymentStatus(appointmentId, status, extra = {}) {
  if (!appointmentId || !status) return false;
  return emitToRoom(appointmentId, 'payment_status_changed', {
    appointmentId: String(appointmentId),
    roomId: String(appointmentId),
    status,
    changedAt: new Date().toISOString(),
    ...extra,
  });
}

/**
 * Video-call lifecycle. The signalling and persistence already exist
 * (videoCallController + VideoCall); these give the UI a live trigger so the
 * upcoming in-app video work is a screen change, not new transport.
 */
async function emitVideoCallStarted(appointmentId, call = {}) {
  if (!appointmentId) return false;
  return emitToRoom(appointmentId, 'video_call_started', {
    appointmentId: String(appointmentId),
    roomId: String(appointmentId),
    callId: call.callId ? String(call.callId) : undefined,
    roomUrl: call.roomUrl,
    provider: call.provider,
    startedAt: new Date().toISOString(),
  });
}

async function emitVideoCallEnded(appointmentId, call = {}) {
  if (!appointmentId) return false;
  return emitToRoom(appointmentId, 'video_call_ended', {
    appointmentId: String(appointmentId),
    roomId: String(appointmentId),
    callId: call.callId ? String(call.callId) : undefined,
    duration: call.duration,
    endedAt: new Date().toISOString(),
  });
}

module.exports = {
  emitAppointmentStatus,
  emitPaymentStatus,
  emitVideoCallStarted,
  emitVideoCallEnded,
};
