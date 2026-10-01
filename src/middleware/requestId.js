const crypto = require('crypto');
const logger = require('../utils/logger');

// A caller-supplied id is kept (so a client or proxy can correlate its own
// logs) only if it looks like an id — never echo arbitrary header content.
const ACCEPTABLE_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Tag every request with an id: req.id, the X-Request-Id response header,
 * req.log (a logger child carrying it) and — via the error handler — the
 * error body, so a user-reported failure can be found in the logs.
 */
function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && ACCEPTABLE_ID.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  req.log = logger.child({ requestId: req.id });
  next();
}

module.exports = requestId;
