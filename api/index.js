/**
 * Vercel serverless entry point.
 *
 * Wraps the Express app (src/app.js) for Vercel's Node runtime.
 * The MongoDB connection is cached across warm invocations — connect once,
 * reuse on every subsequent request in the same lambda instance.
 */
const mongoose = require('mongoose');

// Throws at cold start on missing or unsafe configuration (e.g. equal JWT and
// refresh secrets), so a misconfigured deploy fails loudly instead of serving.
require('../src/config/validateEnv')();

const app = require('../src/app');
const { corsMiddleware } = require('../src/gateway/security');

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
  // A browser preflight needs no database. Answering it here keeps it off the
  // cold-start connect, which every web call would otherwise wait on twice.
  // The callback only runs for an origin CORS refused: no CORS headers, so
  // the browser blocks the call that follows.
  if (req.method === 'OPTIONS') {
    return corsMiddleware(req, res, () => {
      res.statusCode = 204;
      res.end();
    });
  }

  try {
    await ensureDb();
  } catch (err) {
    console.error('DB connection failed:', err.message);
    // Sent before Express runs, so it needs its own CORS headers; without
    // them a browser shows this as an opaque network error.
    return corsMiddleware(req, res, () => {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: false, error: 'Database connection failed' }));
    });
  }
  return app(req, res);
};
