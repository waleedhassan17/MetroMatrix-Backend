/**
 * Build the indexes every model declares.
 *
 * api/index.js no longer lets Mongoose issue createIndex on every cold start
 * (MONGOOSE_AUTO_INDEX restores that), so run this after deploying a change
 * that adds or alters an index. createIndexes only adds — it never drops — so
 * superseded indexes that would now be WRONG are dropped explicitly below.
 *
 *   node scripts/sync-indexes.js --dry
 *   node scripts/sync-indexes.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const DRY = process.argv.includes('--dry');

// Indexes whose replacement differs in key, so both cannot coexist sensibly.
const SUPERSEDED = [
  {
    collection: 'slots',
    name: 'uniq_single_patient_slot',
    why: 'did not include `type`, so video and in-clinic at the same clinic and time collided',
  },
];

/** Load every model file so every schema is registered. */
function loadModels(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      loadModels(full);
    } else if (entry.name.endsWith('.js') && path.basename(dir) === 'models') {
      require(full);
    }
  }
}

(async () => {
  loadModels(path.join(__dirname, '..', 'src'));
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  const db = mongoose.connection.db;

  for (const { collection, name, why } of SUPERSEDED) {
    const existing = await db.collection(collection).indexes().catch(() => []);
    if (existing.some((ix) => ix.name === name)) {
      console.log(`${DRY ? '[dry] would drop' : 'dropping'} ${collection}.${name} — ${why}`);
      if (!DRY) await db.collection(collection).dropIndex(name);
    }
  }

  for (const modelName of mongoose.modelNames()) {
    const model = mongoose.model(modelName);
    const declared = model.schema.indexes().length;
    if (!declared) continue;
    if (DRY) {
      console.log(`[dry] ${modelName}: ${declared} declared index(es)`);
      continue;
    }
    try {
      await model.createIndexes();
      console.log(`${modelName}: ok (${declared})`);
    } catch (err) {
      // Most often a unique index the existing data violates — report and go on.
      console.error(`${modelName}: ${err.message}`);
    }
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
