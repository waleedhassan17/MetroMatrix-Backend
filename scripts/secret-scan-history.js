/**
 * Scan every commit's ADDED lines for things that look like secrets and
 * report WHERE they appeared — commit, date, file, kind — never the value.
 * Used to build docs/SECURITY_ROTATION.md: anything listed here was public
 * from that commit on and has to be rotated; deleting it now doesn't help.
 *
 * Usage: node scripts/secret-scan-history.js [repoPath] [--json]
 * (node_modules/ is skipped; CI additionally runs gitleaks on every push.)
 */
const { spawn } = require('child_process');
const readline = require('readline');

const repo = process.argv.slice(2).find((a) => !a.startsWith('--')) || process.cwd();
const asJson = process.argv.includes('--json');

// [kind, regex]. Regexes match the shape of a real value, not just the
// variable name, so documentation that merely names a variable isn't flagged.
const RULES = [
  ['mongodb-uri-with-credentials', /mongodb(?:\+srv)?:\/\/[^\s:@/'"`]+:[^\s@/'"`]{3,}@/],
  ['stripe-secret-key', /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{10,}/],
  ['stripe-webhook-secret', /\bwhsec_[0-9A-Za-z]{10,}/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{30,}/],
  ['private-key-block', /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/],
  ['jwt-secret-assignment', /\b(?:JWT_SECRET|REFRESH_TOKEN_SECRET)\s*[=:]\s*['"]?[^\s'"<>$]{8,}/],
  ['cloudinary-secret-assignment', /\bCLOUDINARY_API_SECRET\s*[=:]\s*['"]?[^\s'"<>$]{8,}/],
  ['smtp-password-assignment', /\bEMAIL_(?:PASS|PASSWORD)\s*[=:]\s*['"]?[^\s'"<>$]{6,}/],
  ['oauth-client-secret-assignment', /\b(?:GOOGLE_CLIENT_SECRET|FACEBOOK_APP_SECRET)\s*[=:]\s*['"]?[^\s'"<>$]{8,}/],
  ['firebase-private-key-assignment', /\bFIREBASE_PRIVATE_KEY\s*[=:]\s*['"]?-----BEGIN/],
  ['cloudinary-url-with-secret', /cloudinary:\/\/\d+:[^@\s]{8,}@/],
  ['admin-password-literal', /\b(?:myPassword|admin\.password|ADMIN_PASSWORD)\s*=\s*['"][^'"]{6,}['"]/],
];

const git = spawn(
  'git',
  ['-C', repo, 'log', '--all', '-p', '--no-color', '--unified=0', '--format=@@COMMIT %h %ad', '--date=short', '--', '.', ':(exclude)node_modules'],
  { stdio: ['ignore', 'pipe', 'inherit'] }
);

const findings = new Map(); // key → finding
let commit = null;
let date = null;
let file = null;

const rl = readline.createInterface({ input: git.stdout, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (line.startsWith('@@COMMIT ')) {
    [, commit, date] = line.split(' ');
    return;
  }
  if (line.startsWith('+++ ')) {
    file = line.startsWith('+++ b/') ? line.slice(6) : null;
    return;
  }
  if (!file || !line.startsWith('+') || line.startsWith('+++')) return;
  for (const [kind, re] of RULES) {
    if (re.test(line)) {
      const key = `${kind}|${file}`;
      const prev = findings.get(key);
      // Keep the EARLIEST commit (git log is newest-first, so overwrite).
      findings.set(key, { kind, file, firstSeenCommit: commit, firstSeenDate: date, commits: (prev?.commits || 0) + 1 });
    }
  }
});

git.on('close', (code) => {
  const rows = [...findings.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.file.localeCompare(b.file));
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
  } else if (!rows.length) {
    console.log('No secret-shaped values found in history.');
  } else {
    console.log('kind | file | first seen (commit, date) | commits adding it');
    for (const r of rows) console.log(`${r.kind} | ${r.file} | ${r.firstSeenCommit} ${r.firstSeenDate} | ${r.commits}`);
  }
  process.exit(code === 0 ? 0 : 1);
});
