/**
 * Provider presence — is "online" still true?
 *
 * `isOnline` is a manual toggle; nothing used to switch it off when a provider
 * simply closed the app, so customers were shown "online" for people who had
 * gone home hours earlier. The app now sends a heartbeat every few minutes
 * while a provider is online and in the foreground, and search treats
 * "online" as true only if `lastSeen` is recent (settings.onlineStaleMinutes).
 *
 * Writing `lastSeen` on every heartbeat would be a database write per provider
 * per few minutes. A Redis key with a TTL (SET NX EX) throttles it to one
 * write per window across all serverless instances; without Redis a
 * per-instance memory throttle does the same job less precisely.
 */
const Provider = require('../../../models/Provider');
const { withRedis, k } = require('../../../lib/redis');

const WRITE_EVERY_SEC = 240;
const memo = new Map();

/** @returns {Promise<boolean>} whether lastSeen was written */
async function touch(providerId, now = new Date()) {
  const id = String(providerId);
  const claimed = await withRedis(
    (r) => r.set(k('pres', 'hs', 'p', id), '1', { nx: true, ex: WRITE_EVERY_SEC }),
    'no-redis'
  );
  if (claimed === null) return false; // another instance wrote within the window
  if (claimed === 'no-redis') {
    const last = memo.get(id) || 0;
    if (now.getTime() - last < WRITE_EVERY_SEC * 1000) return false;
    memo.set(id, now.getTime());
    if (memo.size > 10000) memo.clear();
  }
  await Provider.updateOne({ _id: id }, { $set: { lastSeen: now } });
  withRedis((r) => r.zadd(k('pres', 'hs', 'z'), { score: now.getTime(), member: id }));
  return true;
}

/** Providers seen within the window (Redis only; null when unavailable). */
async function recentlySeenCount(windowMin, now = Date.now()) {
  return withRedis((r) => r.zcount(k('pres', 'hs', 'z'), now - windowMin * 60 * 1000, '+inf'), null);
}

function __resetForTests() {
  memo.clear();
}

module.exports = { touch, recentlySeenCount, WRITE_EVERY_SEC, __resetForTests };
