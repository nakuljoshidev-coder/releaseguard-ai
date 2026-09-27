// Vercel serverless entrypoint — re-exports the Express app as a handler.
const app = require('../src/app');

module.exports = app;
