const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Runs once, before any suite. The URI is handed to the suites through the
// environment, which test/setupEnv.js reads (and narrows to a per-file
// database) before dotenv gets a chance to load the real .env value.
module.exports = async () => {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  globalThis.__MONGO_REPLSET__ = replSet;
  process.env.TEST_MONGODB_BASE_URI = replSet.getUri();
};
