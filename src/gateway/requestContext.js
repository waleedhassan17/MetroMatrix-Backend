/**
 * Request identity: every request gets an id that is echoed back as
 * `X-Request-Id`, stamped on error responses and forwarded to the realtime
 * service, so one failing tap on a phone can be followed through both servers'
 * logs.
 *
 * An inbound id is kept only if it looks like one we could have issued — a
 * caller must not be able to inject arbitrary text into our log lines.
 */
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();
const VALID_ID = /^[A-Za-z0-9._-]{8,64}$/;
const API_VERSION = '1';

function requestContext(req, res, next) {
  const inbound = req.headers['x-request-id'];
  const id = typeof inbound === 'string' && VALID_ID.test(inbound) ? inbound : crypto.randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  res.setHeader('X-API-Version', API_VERSION);
  storage.run({ requestId: id, startedAt: Date.now() }, next);
}

/** The current request's id, from anywhere in its async call chain. */
function currentRequestId() {
  const store = storage.getStore();
  return store ? store.requestId : undefined;
}

module.exports = { requestContext, currentRequestId, VALID_ID };
