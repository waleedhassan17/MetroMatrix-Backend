/**
 * Vercel serverless entry point.
 *
 * Wraps the Express app (src/app.js) for Vercel's Node runtime.
 * The MongoDB connection is cached across warm invocations — connect once,
 * reuse on every subsequent request in the same lambda instance.
 */
const mongoose = require('mongoose');
const app = require('../src/app');

let connPromise = null;

const ensureDb = () => {
  if (mongoose.connection.readyState === 1) return Promise.resolve();
  if (!connPromise) {
    connPromise = mongoose
      .connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 10000,
        // Every cold start used to re-issue createIndex for every index of
        // every model. Indexes are built by scripts/sync-indexes.js instead;
        // set MONGOOSE_AUTO_INDEX=true to restore the old behaviour.
        autoIndex: process.env.MONGOOSE_AUTO_INDEX === 'true',
      })
      .catch((err) => {
        connPromise = null; // allow retry on the next request
        throw err;
      });
  }
  return connPromise;
};

module.exports = async (req, res) => {
  try {
    await ensureDb();
  } catch (err) {
    console.error('DB connection failed:', err.message);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ success: false, error: 'Database connection failed' }));
  }
  return app(req, res);
};
