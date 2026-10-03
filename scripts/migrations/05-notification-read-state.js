/**
 * 05 — per-admin notification state (phase B3).
 *
 * Notifications had one global isRead flag. Each read notification becomes
 * read for every admin that exists now (readBy), the legacy severity moves to
 * the top level, and the provider/user reference becomes `target`. isRead and
 * readAt are then unset. Idempotent (only documents still carrying isRead are
 * touched). Rollback: the previous release treats missing isRead as unread.
 */
const { runMigration } = require('./lib');
const Notification = require('../../src/models/Notification');
const Admin = require('../../src/models/Admin');

runMigration('05-notification-read-state', async ({ dry, log }) => {
  const adminIds = (await Admin.collection.find({}, { projection: { _id: 1 } }).toArray()).map((a) => a._id);
  const coll = Notification.collection;
  const docs = await coll.find({ isRead: { $exists: true } }).toArray();
  const ops = docs.map((n) => {
    const set = {
      readBy: n.isRead ? adminIds : n.readBy || [],
      dismissedBy: n.dismissedBy || [],
      severity: n.severity || n.data?.severity || 'info',
    };
    if (!n.target?.type) {
      if (n.data?.providerId) set.target = { type: 'Provider', id: n.data.providerId };
      else if (n.data?.userId) set.target = { type: 'User', id: n.data.userId };
    }
    return { updateOne: { filter: { _id: n._id }, update: { $set: set, $unset: { isRead: '', readAt: '' } } } };
  });
  if (!dry && ops.length) await coll.bulkWrite(ops, { ordered: false });
  if (!dry) await Notification.createIndexes();
  log(`notifications converted: ${ops.length}; admins: ${adminIds.length}`);
  return { converted: ops.length };
}).catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
