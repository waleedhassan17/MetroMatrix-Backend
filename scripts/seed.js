/**
 * Orchestrator for `npm run seed` — runs every module seed script in
 * sequence. Each script owns its own MongoDB connect/disconnect and exits
 * non-zero on failure, so this just chains them as child processes and
 * stops at the first failure.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const SCRIPTS = [
  'seed-accounts.js',
  'seed-healthcare.js',
  'seed-homeservice.js',
  'seed-shopping.js', // also seeds Cougar + Outfitters via src/modules/shopping/seed/brands.seed.js
];

for (const script of SCRIPTS) {
  console.log(`\n=== Running ${script} ===`);
  const result = spawnSync(process.execPath, [path.join(__dirname, script)], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\n${script} failed (exit ${result.status}) — stopping.`);
    process.exit(result.status || 1);
  }
}

console.log('\n=== All seeds complete ===');
