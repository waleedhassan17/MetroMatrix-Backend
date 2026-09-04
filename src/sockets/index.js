// ============================================================================
// Room-event publisher.
//
// THIS SERVICE HOLDS NO SOCKET. It runs on Vercel, where a serverless function
// cannot keep a websocket open. The live socket lives in the separate
// `metromatrix-realtime` service.
//
// What used to be here was a full socket.io implementation — initSockets, a
// chat handler, a tracking handler — attached in src/server.js, the
// long-running entry used by `npm start`. But vercel.json rewrites every
// request to api/index.js, which never calls initSockets, so IN PRODUCTION
// `io` was always null and `emitToBooking`'s opening `if (!io) return;` made
// every call site a silent no-op — each wrapped in an empty `catch {}` that hid
// it. That is why live tracking never moved, booking status never advanced on
// the customer's screen, and payment requests never arrived. It worked only
// when someone ran the server locally, which is why it looked implemented.
//
// Now these functions PUBLISH to the realtime service's internal bridge, which
// owns the socket and fans out to the room. The call sites are unchanged.
//
// Rooms are polymorphic — a room id is either an HSBooking _id
// (roomType 'homeservice') or an Appointment _id (roomType 'healthcare') — so
// healthcare publishes through exactly the same path.
// ============================================================================

const REALTIME_URL = process.env.REALTIME_URL || '';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

// A booking transition or a payment must never fail, or even stall, because the
// realtime dyno is slow or asleep. Publishing is best-effort with a hard cap.
const PUBLISH_TIMEOUT_MS = 2000;

let warnedMissingConfig = false;

function configured() {
  if (REALTIME_URL && INTERNAL_API_KEY) return true;
  if (!warnedMissingConfig) {
    warnedMissingConfig = true;
    console.warn(
      '[realtime] REALTIME_URL / INTERNAL_API_KEY not set — room events will not be delivered. ' +
        'Set both to the realtime service URL and its shared key.'
    );
  }
  return false;
}

/**
 * Publish an event into a room via the realtime service.
 *
 * Fire-and-forget: returns a promise that always resolves, so callers may
 * ignore it. Failures are LOGGED rather than swallowed — the silent-failure
 * pattern this replaces is precisely what let the feature stay broken.
 *
 * @param {string} roomId   HSBooking _id or Appointment _id
 * @param {string} event    must be in the realtime service's EMITTABLE_EVENTS
 * @param {object} payload
 */
async function emitToRoom(roomId, event, payload = {}) {
  if (!roomId || !event || !configured()) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLISH_TIMEOUT_MS);

  try {
    const response = await fetch(`${REALTIME_URL.replace(/\/$/, '')}/api/internal/emit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': INTERNAL_API_KEY,
      },
      body: JSON.stringify({ roomId: String(roomId), event, payload }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(
        `[realtime] emit ${event} room=${roomId} failed: HTTP ${response.status}`
      );
      return false;
    }
    return true;
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `timeout after ${PUBLISH_TIMEOUT_MS}ms` : error?.message;
    console.error(`[realtime] emit ${event} room=${roomId} failed: ${reason}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Publish an event to ONE PERSON, wherever they are in the app.
 *
 * Room events only reach whoever has opened that booking. A provider who has
 * just been sent a new job is by definition not in its room yet — they are on
 * a dashboard, or a job list — so a room emit could never reach them. Every
 * socket joins a personal `user:<id>` room on connect in the realtime service
 * precisely for this.
 *
 * Same best-effort contract as emitToRoom: always resolves, logs on failure,
 * hard 2s cap. A booking must never fail because a notification could not be
 * delivered.
 *
 * @param {string} userId  User or Provider _id
 * @param {string} event   must be in the realtime service's EMITTABLE_EVENTS
 * @param {object} payload
 */
async function emitToUser(userId, event, payload = {}) {
  if (!userId || !event || !configured()) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLISH_TIMEOUT_MS);

  try {
    const response = await fetch(`${REALTIME_URL.replace(/\/$/, '')}/api/internal/emit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': INTERNAL_API_KEY,
      },
      body: JSON.stringify({ userId: String(userId), event, payload }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(
        `[realtime] emit ${event} user=${userId} failed: HTTP ${response.status}`
      );
      return false;
    }
    return true;
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `timeout after ${PUBLISH_TIMEOUT_MS}ms` : error?.message;
    console.error(`[realtime] emit ${event} user=${userId} failed: ${reason}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Home-service alias kept so the existing call sites in bookingService,
 * trackingController and paymentController read naturally and did not all have
 * to change. A booking id IS a room id.
 */
function emitToBooking(bookingId, event, payload) {
  return emitToRoom(bookingId, event, payload);
}

/**
 * Push to one person's devices via the realtime service.
 *
 * `emitToUser` only reaches a socket that is currently connected. A provider
 * whose app is closed — the normal state when a job request arrives — is
 * reachable only by push, and the Expo client and the token lookup both live in
 * the realtime service.
 *
 * `role` picks the collection: push tokens are stored on Provider for providers
 * and User for customers.
 *
 * Same best-effort contract as the emit functions: always resolves, logs on
 * failure, hard 2s cap.
 *
 * @param {string} userId  User or Provider _id
 * @param {'provider'|'user'} role
 * @param {{type:string, title:string, body?:string, data?:object}} notification
 *        `type` must be in the realtime service's PUSHABLE_TYPES
 */
async function pushToUser(userId, role, { type, title, body, data } = {}) {
  if (!userId || !type || !title || !configured()) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLISH_TIMEOUT_MS);

  try {
    const response = await fetch(`${REALTIME_URL.replace(/\/$/, '')}/api/internal/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': INTERNAL_API_KEY,
      },
      body: JSON.stringify({ userId: String(userId), role, type, title, body, data }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(`[realtime] push ${type} user=${userId} failed: HTTP ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    const reason =
      error?.name === 'AbortError' ? `timeout after ${PUBLISH_TIMEOUT_MS}ms` : error?.message;
    console.error(`[realtime] push ${type} user=${userId} failed: ${reason}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { emitToRoom, emitToBooking, emitToUser, pushToUser };
