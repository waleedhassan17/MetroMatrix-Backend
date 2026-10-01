/**
 * Shared runner for one-off data migrations.
 *
 *   node scripts/migrations/<NN-name>.js --confirm-db=<db name> [--dry]
 *
 * - --confirm-db must name the database MONGODB_URI points at (same rule as
 *   the seed scripts — you have to say which database you are changing).
 * - --dry reports what would change and changes nothing.
 * - Migrations are idempotent: running one twice is a no-op the second time.
 * Run them in numeric order; docs/RELEASE_CHECKLIST.md lists the order and
 * the rollback note for each.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { parseTarget, describeUri } = require('../lib/seedSafety');

async function runMigration(name, up) {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry');
  const uri = process.env.MONGODB_URI;
  const target = parseTarget(uri);
  if (!target) throw new Error('MONGODB_URI is missing or not a MongoDB URI');

  const confirmed = (argv.find((a) => a.startsWith('--confirm-db=')) || '').slice('--confirm-db='.length);
  if (confirmed !== target.dbName) {
    console.error(`\n✋ ${name} would modify ${describeUri(uri)}.\n   Re-run with --confirm-db=${target.dbName}${dry ? ' --dry' : ''}.\n`);
    process.exit(1);
  }

  console.log(`${name} → ${describeUri(uri)}${dry ? ' (DRY RUN — no changes)' : ''}`);
  await mongoose.connect(uri, { autoIndex: false });
  try {
    const report = await up({ dry, db: mongoose.connection.db, log: (m) => console.log(`  ${m}`) });
    console.log(`${name}: done${dry ? ' (dry run)' : ''}${report ? ` — ${JSON.stringify(report)}` : ''}`);
  } finally {
    await mongoose.disconnect();
  }
}

module.exports = { runMigration };
