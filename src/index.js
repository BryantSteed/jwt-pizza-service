const app = require('./service.js');
const metrics = require('./metrics.js');
const logger = require('./logger.js');

metrics.startReporting(10000);
logger.start();

// Errors that never reach the Express error handler.
process.on('unhandledRejection', (reason) => {
  logger.unhandledErrorLogger(reason instanceof Error ? reason : new Error(String(reason)));
});
process.on('uncaughtException', (error) => {
  console.error(error);
  const exitAfterLogging = () => process.exit(1);
  setTimeout(exitAfterLogging, 2000).unref();
  logger.unhandledErrorLogger(error).finally(exitAfterLogging);
});

const port = process.argv[2] || 3000;
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
