/**
 * Write every mounted route (method, path, middleware names) to
 * docs/ROUTES.json. With --check, fail instead if the file is out of date —
 * CI runs that, so a route can't be added, removed or re-guarded without the
 * change showing up in review.
 *
 * Usage: node scripts/dump-routes.js [--check]
 */
const fs = require('fs');
const path = require('path');

// The app logs config warnings at require time; they are noise here.
const quiet = () => {};
const original = { log: console.log, warn: console.warn, error: console.error };
console.log = quiet;
console.warn = quiet;
console.error = quiet;
const app = require('../src/app');
const { routeTable } = require('../src/utils/routeTable');
Object.assign(console, original);

const target = path.join(__dirname, '..', 'docs', 'ROUTES.json');
const json = `${JSON.stringify(routeTable(app), null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== json) {
    console.error('docs/ROUTES.json is out of date — run `node scripts/dump-routes.js` and commit the result.');
    process.exit(1);
  }
  console.log('docs/ROUTES.json is up to date.');
  process.exit(0);
}

fs.writeFileSync(target, json);
console.log(`Wrote ${JSON.parse(json).length} routes to docs/ROUTES.json`);
process.exit(0);
