const pino = require('pino');

const logLevel = process.env.LOG_LEVEL || 'info';

// Silent or lightweight pino logger
const logger = pino({
  level: logLevel,
  timestamp: pino.stdTimeFunctions.isoTime
});

module.exports = logger;
