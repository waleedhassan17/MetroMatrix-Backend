// Lint gate. Rules that catch real bugs (undefined names, unreachable code,
// missing requires, unsafe regex) are errors and fail CI. Stylistic or noisy
// rules are warnings — the warning count is recorded in
// docs/admin-hardening/BASELINE.md and should only go down.
module.exports = {
  root: true,
  env: { node: true, es2022: true },
  parserOptions: { ecmaVersion: 2022, sourceType: 'script' },
  plugins: ['n', 'security'],
  extends: ['eslint:recommended', 'plugin:n/recommended', 'plugin:security/recommended'],
  settings: {
    // Vercel runs Node 18+; package.json "engines" says >=14 only for npm.
    n: { version: '>=18.0.0' },
  },
  rules: {
    'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true, caughtErrors: 'none' }],
    'no-empty': ['warn', { allowEmptyCatch: true }],
    'no-useless-escape': 'warn',
    'no-prototype-builtins': 'warn',
    'no-case-declarations': 'warn',
    'no-inner-declarations': 'warn',
    'n/no-process-exit': 'off', // CLI scripts exit deliberately
    'n/shebang': 'off', // only meaningful for package "bin" entries
    'n/no-unpublished-require': 'off', // devDependencies are fine in tests/scripts
    'n/no-extraneous-require': 'error',
    'n/no-missing-require': 'error',
    // Mostly false positives on obj[key] with internal keys; real cases are
    // covered by express-mongo-sanitize and schema validation.
    'security/detect-object-injection': 'off',
    'security/detect-non-literal-fs-filename': 'warn',
    'security/detect-non-literal-regexp': 'warn',
    'security/detect-possible-timing-attacks': 'warn',
  },
  overrides: [
    {
      files: ['**/__tests__/**/*.js', 'test/**/*.js', '**/*.test.js'],
      env: { jest: true },
    },
  ],
  ignorePatterns: ['node_modules/', 'coverage/', 'scripts/scraped/'],
};
