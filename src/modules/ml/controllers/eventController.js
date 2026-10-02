const asyncHandler = require('express-async-handler');
const { recordEvents, MAX_BATCH } = require('../services/eventService');

function actorOf(req) {
  if (!req.user) return { userId: null, role: null };
  return {
    userId: String(req.user._id),
    role: req.isAdmin ? 'admin' : req.isProvider ? 'provider' : 'user',
  };
}

/**
 * POST /api/events  { events: [{ module, type, refId?, query?, meta?, features?, ts? }] }
 *
 * Accepts up to 50 events; malformed ones are dropped, not rejected.
 * 202 because nothing the client does depends on the write.
 */
const postEvents = asyncHandler(async (req, res) => {
  const events = req.body && req.body.events;
  if (!Array.isArray(events)) {
    res.status(400);
    throw new Error('events must be an array');
  }
  const accepted = await recordEvents(events, actorOf(req));
  res.status(202).json({ success: true, data: { accepted, max: MAX_BATCH } });
});

module.exports = { postEvents, actorOf };
