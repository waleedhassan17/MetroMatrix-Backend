const mongoose = require('mongoose');

// Each test file gets its own database (test/setupEnv.js); these manage the
// connection and wipe it between tests.

async function connect() {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI);
  }
}

async function clear() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

async function disconnect() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
}

module.exports = { connect, clear, disconnect };
