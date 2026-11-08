require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const { initDatabase } = require('./utils/db');
const { flushAllAuthStates } = require('./mysqlAuthState');
const sessionManager = require('./sessionManager');
const logger = require('./utils/logger');
const { authMiddleware } = require('./routes/authMiddleware');

const sessionRoutes = require('./routes/sessions');
const messageRoutes = require('./routes/messages');
const numberRoutes = require('./routes/numbers');

const app = express();

// Trust reverse proxy (e.g. Nginx, Cloudflare, Heroku/Render)
app.set('trust proxy', 1);

// Disable CORS by default (server-to-server only)
// Explicitly disallow arbitrary browser cross-origin requests
app.use((req, res, next) => {
  res.removeHeader('Access-Control-Allow-Origin');
  next();
});

// JSON body parser with strict size limit (max 25MB for metadata, media is sent via URL)
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Simple rate limiter per IP (e.g. 120 requests per minute)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'rate_limit_exceeded' }
});
app.use(limiter);

// 1. Health check (no auth required, used by UptimeRobot keep-alive)
app.get('/health', (req, res) => {
  return res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    sessions: sessionManager.getSessionCount()
  });
});

// 2. Protected Routes (require X-API-KEY header)
app.use('/sessions', authMiddleware, sessionRoutes);
app.use('/messages', authMiddleware, messageRoutes);
app.use('/numbers', authMiddleware, numberRoutes);

// Fallback 404 handler
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found' });
});

// Global Express Error Handler
app.use((err, req, res, next) => {
  logger.error({ error: err.message, stack: err.stack }, 'Unhandled express request error');
  res.status(err.status || 500).json({ ok: false, error: err.message || 'internal_server_error' });
});

// Global unhandledRejection / uncaughtException handlers to keep process alive
process.on('uncaughtException', (err) => {
  logger.fatal({ error: err.message, stack: err.stack }, 'Uncaught Exception in process');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason: reason instanceof Error ? reason.message : reason }, 'Unhandled Rejection in process');
});

// Graceful shutdown handling
let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, 'Graceful shutdown initiated');

  try {
    // 1. Flush all pending MySQL auth batch writes
    await flushAllAuthStates();
    // 2. Close active sockets cleanly without logging out
    await sessionManager.closeAllSockets();
    logger.info('Cleaned up sockets and flushed auth states successfully');
  } catch (err) {
    logger.error({ error: err.message }, 'Error during graceful shutdown');
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server
const PORT = parseInt(process.env.PORT || '3000', 10);

async function startServer() {
  try {
    // Auto-create database tables if not existing
    await initDatabase();

    // Auto-restore previously connected sessions
    await sessionManager.restoreSavedSessions();

    app.listen(PORT, () => {
      logger.info(`WhatsApp Gateway listening on port ${PORT}`);
    });
  } catch (err) {
    logger.fatal({ error: err.message }, 'Failed to bootstrap gateway service');
    // Still listen so healthcheck can report or retry DB
    app.listen(PORT, () => {
      logger.warn(`WhatsApp Gateway started in degraded mode on port ${PORT}`);
    });
  }
}

startServer();
