/**
 * Guard: nothing that moves money may read through Redis.
 *
 * WALLET_DESIGN.md explains why the ledger has no cache: a stale balance or
 * commission rate is a wrong payment. This test fails the build if any money
 * module starts importing the cache or the Redis client.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..');
const MONEY_FILES = [
  'services/walletService.js',
  'controllers/walletController.js',
  'modules/homeservice/services/paymentService.js',
  'modules/homeservice/services/money.js',
  'modules/homeservice/controllers/paymentController.js',
  'modules/homeservice/controllers/earningsController.js',
];

describe('money paths never use the cache', () => {
  it.each(MONEY_FILES)('%s does not import lib/cache or lib/redis', (rel) => {
    const file = path.join(SRC, rel);
    if (!fs.existsSync(file)) return; // file moved: nothing to guard here
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toMatch(/lib\/cache|lib\/redis|@upstash/);
  });

  it('homeservice settings stay uncached unless a caller opts in', () => {
    const text = fs.readFileSync(path.join(SRC, 'modules/homeservice/services/settingsService.js'), 'utf8');
    expect(text).toMatch(/getHomeserviceSettings\(\{ cached = false \} = \{\}\)/);
    for (const rel of MONEY_FILES) {
      const file = path.join(SRC, rel);
      if (fs.existsSync(file)) {
        expect(fs.readFileSync(file, 'utf8')).not.toMatch(/getHomeserviceSettings\(\{\s*cached:\s*true/);
      }
    }
  });
});
