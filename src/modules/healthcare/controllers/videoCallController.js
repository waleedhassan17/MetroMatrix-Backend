const VideoCall = require('../models/VideoCall');
const Appointment = require('../models/Appointment');
const Slot = require('../models/Slot');
const { createNotification } = require('../services/notificationService');

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
    let isParticipant = appointment.patientId.toString() === req.user._id.toString();
    if (!isParticipant) {
      const Doctor = require('../models/Doctor');
      const doctor = await Doctor.findOne({ providerId: req.user._id }).select('_id');
      isParticipant = !!doctor && appointment.doctorId.toString() === doctor._id.toString();
    }
    if (!isParticipant) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    if (appointment.type !== 'video') {
      return res.status(400).json({ success: false, error: 'This is not a video appointment' });
    }

    if (appointment.status !== 'confirmed') {
      return res.status(400).json({ success: false, error: 'Appointment must be confirmed' });
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

    // Transport: Jitsi Meet room rendered in a WebView on both sides.
    // Free, no API key, works in the Expo managed workflow
    // (see TELEMEDICINE_DECISION.md). Room name derives from the
    // appointment id and is only disclosed to participants by this API.
    const roomName = `MetroMatrix-${appointment._id}`;
    const roomUrl = `https://meet.jit.si/${roomName}#config.prejoinConfig.enabled=false&config.disableDeepLinking=true`;

    res.status(200).json({
      success: true,
      data: {
        callId: videoCall._id,
        roomId: videoCall.roomId,
        provider: 'jitsi',
        roomName,
        roomUrl,
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