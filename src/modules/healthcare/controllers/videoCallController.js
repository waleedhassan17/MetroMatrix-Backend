const VideoCall = require('../models/VideoCall');
const Appointment = require('../models/Appointment');
const Slot = require('../models/Slot');
const { createNotification } = require('../services/notificationService');
const { emitVideoCallStarted, emitVideoCallEnded } = require('../services/roomEvents');

/**
 * How long before its start time a consultation can be opened.
 *
 * Must stay in step with the app's CONSULT_LEAD_MINUTES (both the patient's
 * join window and the doctor's call button): if the server and the two clients
 * disagree, one party is offered a room the other cannot enter.
 */
const CONSULT_LEAD_MINUTES = Number(process.env.CONSULT_LEAD_MINUTES || 15);
const CONSULT_LEAD_MS = CONSULT_LEAD_MINUTES * 60 * 1000;

// Agora token generation
const generateAgoraToken = (channelName, uid) => {
  try {
    const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
    const expireTime = Math.floor(Date.now() / 1000) + 3600;
    return RtcTokenBuilder.buildTokenWithUid(
      process.env.AGORA_APP_ID,
      process.env.AGORA_APP_CERTIFICATE,
      channelName,
      uid,
      RtcRole.PUBLISHER,
      expireTime
    );
  } catch (e) {
    return 'agora-token-placeholder';
  }
};

// @desc    Join / create video call
// @route   POST /api/v1/healthcare/video-calls/join/:appointmentId
// @access  Private
const joinVideoCall = async (req, res, next) => {
  try {
    const appointment = await Appointment.findById(req.params.appointmentId)
      .populate('slotId');

    if (!appointment) {
      return res.status(404).json({ success: false, error: 'Appointment not found' });
    }

    // Participants only: the patient OR the owning doctor may join
    let isDoctor = false;
    let isParticipant = appointment.patientId.toString() === req.user._id.toString();
    if (!isParticipant) {
      const Doctor = require('../models/Doctor');
      const doctor = await Doctor.findOne({ providerId: req.user._id }).select('_id');
      isDoctor = !!doctor && appointment.doctorId.toString() === doctor._id.toString();
      isParticipant = isDoctor;
    }
    if (!isParticipant) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    if (appointment.type !== 'video') {
      return res.status(400).json({ success: false, error: 'This is not a video appointment' });
    }

    // ------------------------------------------------------------------
    // A DOCTOR ANSWERING THE CALL *IS* THE CONFIRMATION.
    //
    // This required status === 'confirmed', but bookAppointment creates
    // appointments as 'pending' and only an explicit doctor action confirmed
    // them. So a consultation on a freshly booked appointment always failed
    // here — in production 4 of 6 video appointments were pending, so this
    // fired on essentially every call, for both parties.
    //
    // The media is peer-to-peer and connected anyway, which made it look
    // cosmetic. It was not: without this record there is no call history and no
    // billing row, `video_call_started` never publishes (so a patient sitting
    // in the waiting room is never pulled in), and the call is never closed out.
    //
    // The patient may join a pending appointment without confirming it — only
    // the doctor's participation carries that meaning. Terminal states still
    // refuse, with distinct messages so the client can tell "already over"
    // from "not allowed".
    // ------------------------------------------------------------------
    if (appointment.status === 'cancelled') {
      return res.status(400).json({ success: false, error: 'This appointment was cancelled' });
    }
    if (appointment.status === 'completed') {
      return res
        .status(400)
        .json({ success: false, error: 'This appointment is already complete' });
    }

    // ------------------------------------------------------------------
    // ONLY INSIDE THE CONSULTATION'S OWN WINDOW.
    //
    // There was no time check of any kind: a doctor could open a call weeks
    // ahead of the appointment. The patient could not answer it — their join
    // opens CONSULT_LEAD_MINUTES before — so it could only ring out, and the
    // appointment was then stranded in 'confirmed', because completing a
    // future appointment is refused (see completeAppointment). The payout is
    // settled at completion, so the doctor's fee was stranded with it.
    //
    // Compared on the real instants, and only when the appointment carries
    // them: rows that predate the startUtc backfill stay joinable rather than
    // becoming unreachable.
    // ------------------------------------------------------------------
    const start = appointment.startUtc || (appointment.slotId && appointment.slotId.startUtc);
    const end = appointment.endUtc || (appointment.slotId && appointment.slotId.endUtc);
    if (start && end) {
      const now = Date.now();
      const opensAt = new Date(start).getTime() - CONSULT_LEAD_MS;
      if (now < opensAt) {
        return res.status(400).json({
          success: false,
          error: `This consultation opens ${CONSULT_LEAD_MINUTES} minutes before its start time.`,
        });
      }
      if (now > new Date(end).getTime()) {
        return res
          .status(400)
          .json({ success: false, error: 'This consultation time has passed.' });
      }
    }

    if (appointment.status === 'pending' && isDoctor) {
      appointment.status = 'confirmed';
      await appointment.save();
      console.log(`[video] appointment ${appointment._id} confirmed by the doctor joining`);
    }

    // Check existing call
    let videoCall = await VideoCall.findOne({ appointmentId: appointment._id });

    if (!videoCall) {
      videoCall = await VideoCall.create({
        appointmentId: appointment._id,
        roomId: 'room_' + appointment._id,
        status: 'waiting'
      });
    } else if (videoCall.status === 'ended') {
      return res.status(400).json({ success: false, error: 'This call has already ended' });
    }

    if (videoCall.status === 'waiting') {
      videoCall.status = 'active';
      videoCall.startedAt = videoCall.startedAt || new Date();
      await videoCall.save();
    }

    // Transport: peer-to-peer WebRTC, signalled by the realtime service, with
    // the APPOINTMENT as the room — the same stack home-service audio calls
    // use. There is no room URL to mint any more.
    //
    // This used to hand back a public `https://meet.jit.si/<room>` link that
    // both sides opened in a WebView. That worked, but it meant two media
    // stacks to maintain, a dependency on a rate-limited public instance, and
    // a consultation whose privacy rested on the room name being unguessable.
    // Media now flows directly between the two devices.
    //
    // This endpoint still owns the VideoCall LIFECYCLE (created / active /
    // ended) and the notify below — only the transport changed.
    await emitVideoCallStarted(appointment._id, {
      callId: videoCall._id,
      provider: 'webrtc',
    });

    res.status(200).json({
      success: true,
      data: {
        callId: videoCall._id,
        roomId: videoCall.roomId,
        // The room the app connects to is the appointment; the realtime
        // service authorizes both parties against it.
        appointmentId: String(appointment._id),
        provider: 'webrtc',
        status: videoCall.status
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get call status
// @route   GET /api/v1/healthcare/video-calls/:callId/status
// @access  Private
const getCallStatus = async (req, res, next) => {
  try {
    const videoCall = await VideoCall.findById(req.params.callId);

    if (!videoCall) {
      return res.status(404).json({ success: false, error: 'Video call not found' });
    }

    res.status(200).json({
      success: true,
      data: {
        callId: videoCall._id,
        status: videoCall.status,
        duration: videoCall.duration || null
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    End video call
// @route   POST /api/v1/healthcare/video-calls/:callId/end
// @access  Private
const endVideoCall = async (req, res, next) => {
  try {
    const videoCall = await VideoCall.findById(req.params.callId);

    if (!videoCall) {
      return res.status(404).json({ success: false, error: 'Video call not found' });
    }

    if (videoCall.status === 'ended') {
      return res.status(400).json({ success: false, error: 'Call already ended' });
    }

    const now = new Date();
    videoCall.status = 'ended';
    videoCall.endedAt = now;

    if (videoCall.startedAt) {
      videoCall.duration = Math.floor((now - videoCall.startedAt) / 1000);
    }

    await videoCall.save();

    // Notify doctor
    const appointment = await Appointment.findById(videoCall.appointmentId);
    if (appointment) {
      // Live: closes the other side's call screen immediately rather than
      // leaving it in a Jitsi room the counterpart has already left.
      await emitVideoCallEnded(appointment._id, {
        callId: videoCall._id,
        duration: videoCall.duration,
      });

      await createNotification({
        userId: appointment.doctorId,
        title: 'Video Call Ended',
        message: 'Patient has ended the video call',
        type: 'appointment_cancelled',
        data: { appointmentId: appointment._id }
      });
    }

    res.status(200).json({
      success: true,
      data: {
        callId: videoCall._id,
        status: 'ended',
        duration: videoCall.duration
      }
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { joinVideoCall, getCallStatus, endVideoCall };