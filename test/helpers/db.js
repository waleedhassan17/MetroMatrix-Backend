const mongoose = require('mongoose');

// Each test file gets its own database (test/setupEnv.js); these manage the
// connection and wipe it between tests.

async function connect() {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI);
  }
}

// Every collection that exists — including ones a test wrote to directly
// without a registered model.
async function clear() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

async function disconnect() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
}

module.exports = { connect, clear, disconnect };
