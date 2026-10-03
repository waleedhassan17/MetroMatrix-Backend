// Every suite runs against a throwaway in-memory MongoDB replica set (a
// replica set, not a standalone, so multi-document transactions work). The
// suites that used to read MONGODB_URI from .env were connecting to the shared
// dev/demo Atlas database — test/setupEnv.js now refuses anything that is not
// on this machine.
module.exports = {
  testEnvironment: 'node',
  globalSetup: '<rootDir>/test/globalSetup.js',
  globalTeardown: '<rootDir>/test/globalTeardown.js',
  setupFiles: ['<rootDir>/test/setupEnv.js'],
  testPathIgnorePatterns: ['/node_modules/'],
  coveragePathIgnorePatterns: ['/node_modules/', '<rootDir>/test/'],
  // Every suite shares one replica set and hashes real bcrypt passwords; with
  // all suites in parallel the 5 s default timed out a different test on each
  // run. Half the cores and a 30 s ceiling keep the run deterministic.
  maxWorkers: '50%',
  testTimeout: 30000,
};
