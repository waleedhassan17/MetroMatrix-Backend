const LoginAttempt = require('../../models/LoginAttempt');

/**
 * Failed-attempt counting with lockout, shared across serverless instances
 * (MongoDB-backed — see models/LoginAttempt.js).
 *
 * A key accumulates failures inside a rolling window that starts at its first
 * failure. Reaching `max` locks the key for `lockMs`. Locked keys are refused
 * before the password is even checked, so a correct guess during a lockout
 * does not get in.
 */

async function lockStatus(key, now = new Date()) {
  const doc = await LoginAttempt.findOne({ key }).lean();
  if (doc?.lockedUntil && doc.lockedUntil > now) {
    return { locked: true, retryAfterSeconds: Math.ceil((doc.lockedUntil - now) / 1000), lockedUntil: doc.lockedUntil };
  }
  return { locked: false, retryAfterSeconds: 0, lockedUntil: null };
}

/**
 * Count one failure. Atomic (single pipeline update), so concurrent failures
 * from parallel requests are all counted.
 * @returns {{ count: number, lockedNow: boolean, lockedUntil: Date|null }}
 */
async function registerFailure(key, { max, windowMs, lockMs }, now = new Date()) {
  const windowStart = new Date(now.getTime() - windowMs);
  const lockUntil = new Date(now.getTime() + lockMs);
  const keepUntil = new Date(now.getTime() + Math.max(windowMs, lockMs));
  const update = [
    {
      $set: {
        __inWindow: {
          $and: [{ $ne: [{ $ifNull: ['$windowStartedAt', null] }, null] }, { $gt: ['$windowStartedAt', windowStart] }],
        },
        __wasLocked: { $gt: [{ $ifNull: ['$lockedUntil', new Date(0)] }, now] },
      },
    },
    {
      $set: {
        count: { $cond: ['$__inWindow', { $add: [{ $ifNull: ['$count', 0] }, 1] }, 1] },
        windowStartedAt: { $cond: ['$__inWindow', '$windowStartedAt', now] },
      },
    },
    {
      $set: {
        lockedUntil: {
          $cond: [
            { $and: [{ $gte: ['$count', max] }, { $not: ['$__wasLocked'] }] },
            lockUntil,
            { $ifNull: ['$lockedUntil', null] },
          ],
        },
        expiresAt: { $max: [{ $ifNull: ['$expiresAt', now] }, keepUntil] },
      },
    },
    { $unset: ['__inWindow', '__wasLocked'] },
  ];

  let doc;
  try {
    doc = await LoginAttempt.findOneAndUpdate({ key }, update, { upsert: true, new: true, lean: true });
  } catch (err) {
    // Two first-failures raced to insert the same key: the unique index let
    // one win; count against the winner.
    if (err.code !== 11000) throw err;
    doc = await LoginAttempt.findOneAndUpdate({ key }, update, { new: true, lean: true });
  }
  const lockedNow = !!doc.lockedUntil && doc.lockedUntil.getTime() === lockUntil.getTime();
  return { count: doc.count, lockedNow, lockedUntil: doc.lockedUntil || null };
}

async function clear(key) {
  await LoginAttempt.deleteOne({ key });
}

module.exports = { lockStatus, registerFailure, clear };
