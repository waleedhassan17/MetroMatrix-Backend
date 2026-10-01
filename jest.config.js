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
};
