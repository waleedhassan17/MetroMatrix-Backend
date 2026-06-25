/**
 * Healthcare Doctor schema migration.
 *
 * The Doctor model changed identity from `userId` (User) to `providerId` (Provider).
 * Existing databases may still carry:
 *   1. A stale unique index `userId_1` on the `doctors` collection.
 *   2. Legacy doctor documents that have `userId` but no `providerId`.
 *
 * This script is SAFE BY DEFAULT — it only reports. Pass `--apply` to drop the
 * stale index and sync to the new schema, and `--purge` to also delete legacy
 * doctor documents that cannot be linked to a Provider.
 *
 * Usage:
 *   node src/scripts/migrateHealthcareDoctors.js            # report only
 *   node src/scripts/migrateHealthcareDoctors.js --apply    # drop stale indexes + syncIndexes
 *   node src/scripts/migrateHealthcareDoctors.js --apply --purge   # also remove orphan legacy docs
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Doctor = require('../modules/healthcare/models/Doctor');

const APPLY = process.argv.includes('--apply');
const PURGE = process.argv.includes('--purge');

(async () => {
  await connectDB();
  await new Promise((r) => setTimeout(r, 1500));

  const coll = mongoose.connection.db.collection('doctors');
  const indexes = await coll.indexes();
  console.log('Current indexes:', indexes.map((i) => i.name).join(', '));

  const staleIndexes = ['userId_1'];
  const legacyCount = await Doctor.countDocuments({ providerId: { $exists: false } });
  console.log(`Legacy doctor docs (no providerId): ${legacyCount}`);

  if (!APPLY) {
    console.log('\nReport only. Re-run with --apply to drop stale indexes and sync.');
    if (legacyCount > 0) {
      console.log('Add --purge to delete the legacy docs that cannot be linked to a Provider.');
    }
    await mongoose.connection.close();
    process.exit(0);
  }

  for (const name of staleIndexes) {
    if (indexes.find((i) => i.name === name)) {
      try {
        await coll.dropIndex(name);
        console.log(`Dropped stale index: ${name}`);
      } catch (e) {
        console.log(`Could not drop ${name}: ${e.message}`);
      }
    }
  }

  if (PURGE && legacyCount > 0) {
    const res = await Doctor.deleteMany({ providerId: { $exists: false } });
    console.log(`Purged legacy doctor docs: ${res.deletedCount}`);
  }

  await Doctor.syncIndexes();
  const after = await coll.indexes();
  console.log('Indexes after sync:', after.map((i) => i.name).join(', '));

  await mongoose.connection.close();
  console.log('Migration complete.');
  process.exit(0);
})().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
