const dotenv = require('dotenv');
const colors = require('colors');

dotenv.config();

console.log('Loading environment variables...'.cyan);
console.log('JWT_SECRET:', process.env.JWT_SECRET ? '✓ Loaded' : '✗ Missing'.red);
console.log('MONGODB_URI:', process.env.MONGODB_URI ? '✓ Loaded' : '✗ Missing'.red);

const connectDB = require('./config/db');
console.log('Requiring connectDB...'.cyan);

const app = require('./app');
console.log('Requiring app...'.cyan);

console.log('Calling connectDB()...'.cyan);
connectDB();

const stripe = require('./config/stripe');

const PORT = process.env.PORT || 5000;

console.log('Starting server...'.cyan);
const server = app.listen(PORT, () => {
  console.log(
    `Server running in ${process.env.NODE_ENV} mode on port ${PORT}`.yellow.bold
  );
  console.log('✅ Server is listening!'.green);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err, promise) => {
  console.log(`Error: ${err.message}`.red);
  server.close(() => process.exit(1));
});

process.on('uncaughtException', (err) => {
  console.log(`Error: ${err.message}`.red);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server'.yellow);
  server.close(() => {
    console.log('HTTP server closed'.green);
  });
});

module.exports = server;