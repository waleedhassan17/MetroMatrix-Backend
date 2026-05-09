const { v4: uuidv4 } = require('uuid');
const VideoCall = require('../models/VideoCall');

const getOrCreateRoom = async (appointmentId) => {
  let videoCall = await VideoCall.findOne({ appointmentId });
  if (!videoCall) {
    videoCall = await VideoCall.create({ appointmentId, roomId: uuidv4() });
  }
  return videoCall;
};

const updateCallStatus = async (id, status) => {
  const update = { status };
  if (status === 'active') update.startedAt = new Date();
  if (status === 'ended') {
    update.endedAt = new Date();
    const call = await VideoCall.findById(id);
    if (call && call.startedAt) {
      update.duration = Math.round((new Date() - call.startedAt) / 1000);
    }
  }
  return VideoCall.findByIdAndUpdate(id, update, { new: true, runValidators: true });
};

module.exports = { getOrCreateRoom, updateCallStatus };
