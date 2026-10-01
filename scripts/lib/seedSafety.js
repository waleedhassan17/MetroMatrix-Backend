/**
 * Guard rails shared by every script that writes demo data or logs in with
 * demo/QA accounts.
 *
 * Why: the seed scripts used to connect to whatever MONGODB_URI pointed at
 * (including production), hardcode passwords — the super-admin's among them —
 * and print every login to the console. This repo is public, so anything
 * hardcoded here is public too.
 *
 *  - assertSafeSeedTarget(): refuses NODE_ENV=production unless --i-know, and
 *    always requires --confirm-db=<database name> so the operator has to name
 *    the database they are about to write to.
 *  - demoPassword(): the single password for every seeded demo account, from
 *    SEED_DEMO_PASSWORD. Never printed.
 *  - qaAdminCredentials(): admin login for QA/smoke scripts, from
 *    QA_ADMIN_EMAIL / QA_ADMIN_PASSWORD. Never printed.
 */

const parseTarget = (uri) => {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)(?:\/([^?]*))?/.exec(uri || '');
  if (!match) return null;
  return { host: match[1], dbName: decodeURIComponent(match[2] || '') || 'test' };
};

// For logs: host and database only — never the credentials in the userinfo part.
const describeUri = (uri) => {
  const target = parseTarget(uri);
  return target ? `${target.host}/${target.dbName}` : '<unparseable MONGODB_URI>';
};

const argValue = (argv, name) => {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
};

const fail = (message) => {
  console.error(`\n✋ ${message}\n`);
  process.exit(1);
};

function assertSafeSeedTarget({ argv = process.argv.slice(2), uri = process.env.MONGODB_URI } = {}) {
  const target = parseTarget(uri);
  if (!target) fail('MONGODB_URI is missing or not a mongodb:// / mongodb+srv:// URI.');

  if (process.env.NODE_ENV === 'production' && !argv.includes('--i-know')) {
    fail('NODE_ENV=production — refusing to seed. Re-run with --i-know if this really is intended.');
  }

  const confirmed = argValue(argv, 'confirm-db');
  if (confirmed !== target.dbName) {
    fail(
      `This script writes to ${describeUri(uri)}.\n` +
        `   Re-run with --confirm-db=${target.dbName} to confirm that is the database you mean.`
    );
  }
  console.log(`Seeding target: ${describeUri(uri)}`);
  return target;
}

function demoPassword() {
  const value = process.env.SEED_DEMO_PASSWORD;
  if (!value || value.length < 8) {
    fail('Set SEED_DEMO_PASSWORD (8+ characters) — the password every seeded demo account gets. It is never printed.');
  }
  return value;
}

function qaAdminCredentials() {
  const email = process.env.QA_ADMIN_EMAIL;
  const password = process.env.QA_ADMIN_PASSWORD;
  if (!email || !password) {
    fail('Set QA_ADMIN_EMAIL and QA_ADMIN_PASSWORD to run admin checks (use a non-production admin).');
  }
  return { email, password };
}

module.exports = { assertSafeSeedTarget, demoPassword, qaAdminCredentials, describeUri, parseTarget };
