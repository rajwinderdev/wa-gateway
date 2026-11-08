const {
  default: makeWASocket,
  DisconnectReason,
  Browsers
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const { useMySQLAuthState } = require('./mysqlAuthState');
const { sendWebhook } = require('./webhook');
const { getPool } = require('./utils/db');
const logger = require('./utils/logger');

// Silent pino logger for Baileys socket internals
const silentLogger = pino({ level: 'silent' });

class SessionManager {
  constructor() {
    this.sessions = new Map(); // sessionKey -> sessionObject
    this.maxSessions = parseInt(process.env.MAX_SESSIONS || '20', 10);
  }

  getSessionCount() {
    return this.sessions.size;
  }

  getSession(sessionKey) {
    return this.sessions.get(sessionKey);
  }

  getAllSessions() {
    return Array.from(this.sessions.keys());
  }

  /**
   * Save message_id -> client_ref mapping to MySQL and in-memory cache
   */
  async saveMessageRef(sessionKey, messageId, clientRef) {
    if (!messageId) return;
    try {
      const pool = getPool();
      await pool.query(
        'INSERT INTO `wa_gw_msgmap` (`message_id`, `session_key`, `client_ref`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `client_ref` = VALUES(`client_ref`)',
        [messageId, sessionKey, clientRef || null]
      );
    } catch (e) {
      logger.error({ messageId, sessionKey, error: e.message }, 'Failed to persist message ref in wa_gw_msgmap');
    }
  }

  /**
   * Get client_ref by message_id from MySQL
   */
  async getMessageRef(messageId) {
    if (!messageId) return null;
    try {
      const pool = getPool();
      const [rows] = await pool.query(
        'SELECT `client_ref` FROM `wa_gw_msgmap` WHERE `message_id` = ?',
        [messageId]
      );
      if (rows.length > 0) {
        return rows[0].client_ref;
      }
    } catch (e) {
      logger.error({ messageId, error: e.message }, 'Failed to get message ref from wa_gw_msgmap');
    }
    return null;
  }

  /**
   * Per-session sequential execution queue (mutex)
   */
  async enqueueSessionTask(sessionKey, taskFn) {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      throw new Error('session_not_found');
    }

    // Chain onto current queue promise
    const nextTask = session.queue.then(async () => {
      return await taskFn();
    });

    // Ensure session.queue does not reject and stay stuck
    session.queue = nextTask.catch((err) => {
      logger.debug({ sessionKey, error: err.message }, 'Session queued task error caught in chain');
    });

    return nextTask;
  }

  /**
   * Start or retrieve a session
   */
  async startSession(sessionKey) {
    let session = this.sessions.get(sessionKey);
    if (session) {
      // If already connected or connecting/qr, return state
      return session;
    }

    if (this.maxSessions > 0 && this.sessions.size >= this.maxSessions) {
      const err = new Error('max_sessions_reached');
      err.statusCode = 429;
      throw err;
    }

    session = {
      sessionKey,
      sock: null,
      authState: null,
      status: 'connecting', // 'disconnected', 'connecting', 'qr', 'connected'
      qrBase64: null,
      phone: null,
      name: null,
      qrResolvers: [], // Callbacks waiting for the first QR code
      queue: Promise.resolve(),
      reconnectAttempts: 0,
      reconnectTimeout: null,
      isExplicitLogout: false
    };

    this.sessions.set(sessionKey, session);
    await this.initSocket(session);
    return session;
  }

  async initSocket(session) {
    const { sessionKey } = session;

    // Clean any prior reconnect timeout
    if (session.reconnectTimeout) {
      clearTimeout(session.reconnectTimeout);
      session.reconnectTimeout = null;
    }

    // Load auth state from MySQL
    session.authState = await useMySQLAuthState(sessionKey);

    const sock = makeWASocket({
      auth: session.authState.state,
      logger: silentLogger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      generateHighQualityLinkPreview: false
    });

    session.sock = sock;

    // Save creds on update
    sock.ev.on('creds.update', session.authState.saveCreds);

    // Handle connection update
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        session.status = 'qr';
        try {
          session.qrBase64 = await QRCode.toDataURL(qr);
        } catch (e) {
          session.qrBase64 = null;
        }

        // Notify waiting callers of the first QR
        if (session.qrResolvers.length > 0) {
          const resolvers = session.qrResolvers;
          session.qrResolvers = [];
          for (const res of resolvers) {
            res(session.qrBase64);
          }
        }

        sendWebhook({
          event: 'connection.update',
          session_key: sessionKey,
          status: 'qr'
        });
      }

      if (connection === 'open') {
        session.status = 'connected';
        session.qrBase64 = null;
        session.reconnectAttempts = 0;

        // Extract user info
        const user = sock.user;
        if (user) {
          session.phone = user.id ? user.id.split(':')[0].replace(/[^0-9]/g, '') : null;
          session.name = user.name || null;
        }

        logger.info({ sessionKey, phone: session.phone }, 'Session connected successfully');

        sendWebhook({
          event: 'connection.update',
          session_key: sessionKey,
          status: 'connected',
          phone: session.phone,
          name: session.name
        });

        // Resolve any waiting QR callers since connected
        if (session.qrResolvers.length > 0) {
          const resolvers = session.qrResolvers;
          session.qrResolvers = [];
          for (const res of resolvers) res(null);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.output?.payload?.error || lastDisconnect?.error?.message;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        logger.warn(
          { sessionKey, statusCode, reason },
          'Session connection closed'
        );

        // Remove socket listeners to prevent leaks
        sock.ev.removeAllListeners('creds.update');
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('messages.update');
        sock.ev.removeAllListeners('messages.upsert');

        if (session.isExplicitLogout || isLoggedOut) {
          session.status = 'logged_out';
          sendWebhook({
            event: 'connection.update',
            session_key: sessionKey,
            status: 'logged_out'
          });

          // Delete DB credentials & clean session from memory
          if (session.authState) {
            await session.authState.destroy();
          }
          this.sessions.delete(sessionKey);
          logger.info({ sessionKey }, 'Session logged out and cleaned from MySQL');
        } else {
          session.status = 'disconnected';
          sendWebhook({
            event: 'connection.update',
            session_key: sessionKey,
            status: 'disconnected'
          });

          // Handle restartRequired (515) or reconnection backoff (max ~60s)
          const shouldReconnectImmediately = statusCode === DisconnectReason.restartRequired;
          const delay = shouldReconnectImmediately
            ? 1000
            : Math.min(60000, Math.pow(2, Math.min(session.reconnectAttempts, 6)) * 1000);

          session.reconnectAttempts += 1;
          logger.info({ sessionKey, attempt: session.reconnectAttempts, delay }, 'Scheduling session reconnect');

          session.reconnectTimeout = setTimeout(async () => {
            try {
              await this.initSocket(session);
            } catch (err) {
              logger.error({ sessionKey, error: err.message }, 'Error during socket reconnect');
            }
          }, delay);
        }
      }
    });

    // Handle message status updates (ack levels: sent, delivered, read)
    sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        const messageId = update.key?.id;
        if (!messageId) continue;

        let status = null;
        // Baileys update.update.status mappings:
        // 1 = PENDING / ERROR
        // 2 = SERVER_ACK (sent)
        // 3 = DELIVERY_ACK (delivered)
        // 4 = READ (read)
        // 5 = PLAYED (read/played)
        const updateStatus = update.update?.status;
        if (updateStatus === 2) status = 'sent';
        else if (updateStatus === 3) status = 'delivered';
        else if (updateStatus === 4 || updateStatus === 5) status = 'read';

        if (status) {
          const clientRef = await this.getMessageRef(messageId);
          sendWebhook({
            event: 'message.status',
            session_key: sessionKey,
            message_id: messageId,
            client_ref: clientRef,
            status
          });
        }
      }
    });
  }

  /**
   * Wait up to timeoutMs for the first QR code if session is in QR state
   */
  async waitForFirstQR(session, timeoutMs = 10000) {
    if (session.status === 'connected') {
      return { status: 'connected' };
    }
    if (session.qrBase64) {
      return { status: 'qr', qr: session.qrBase64 };
    }

    return new Promise((resolve) => {
      let resolved = false;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          // Return whatever state we have currently
          resolve({
            status: session.status,
            qr: session.qrBase64 || undefined
          });
        }
      }, timeoutMs);

      session.qrResolvers.push((qr) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          if (session.status === 'connected') {
            resolve({ status: 'connected' });
          } else if (qr) {
            resolve({ status: 'qr', qr });
          } else {
            resolve({ status: session.status });
          }
        }
      });
    });
  }

  /**
   * Log out session cleanly, deleting rows and memory state
   */
  async logoutSession(sessionKey) {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      // Clean from DB in case it exists there
      const pool = getPool();
      await pool.query('DELETE FROM `wa_gw_auth` WHERE `session_key` = ?', [sessionKey]);
      return false;
    }

    session.isExplicitLogout = true;
    if (session.reconnectTimeout) {
      clearTimeout(session.reconnectTimeout);
      session.reconnectTimeout = null;
    }

    try {
      if (session.sock) {
        await session.sock.logout();
      }
    } catch (e) {
      logger.warn({ sessionKey, error: e.message }, 'Error calling sock.logout()');
    }

    if (session.authState) {
      await session.authState.destroy();
    }

    this.sessions.delete(sessionKey);
    return true;
  }

  /**
   * Auto-restore stored sessions that were previously authenticated
   * Staggers start with small delays
   */
  async restoreSavedSessions() {
    try {
      const pool = getPool();
      // Select distinct session_keys that have saved creds
      const [rows] = await pool.query(
        "SELECT DISTINCT `session_key` FROM `wa_gw_auth` WHERE `key_name` = 'creds'"
      );

      logger.info({ count: rows.length }, 'Discovered stored sessions in MySQL for auto-restore');

      let delay = 0;
      for (const row of rows) {
        const sessionKey = row.session_key;
        setTimeout(async () => {
          try {
            logger.info({ sessionKey }, 'Auto-restoring stored session');
            await this.startSession(sessionKey);
          } catch (err) {
            logger.error({ sessionKey, error: err.message }, 'Failed to auto-restore session');
          }
        }, delay);
        delay += 2000; // 2 seconds staggered delay between each restore
      }
    } catch (e) {
      logger.error({ error: e.message }, 'Error querying stored sessions for restore');
    }
  }

  /**
   * Graceful close of all sockets on process termination without logging out
   */
  async closeAllSockets() {
    for (const [key, session] of this.sessions.entries()) {
      if (session.reconnectTimeout) {
        clearTimeout(session.reconnectTimeout);
      }
      try {
        if (session.sock) {
          session.sock.ev.removeAllListeners('creds.update');
          session.sock.ev.removeAllListeners('connection.update');
          session.sock.ev.removeAllListeners('messages.update');
          session.sock.end(undefined);
        }
      } catch (e) {
        logger.debug({ sessionKey: key, error: e.message }, 'Error closing socket during shutdown');
      }
    }
  }
}

const sessionManager = new SessionManager();

module.exports = sessionManager;
