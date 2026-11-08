const mysql = require('mysql2/promise');
const logger = require('./logger');

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.DB_PORT || '3306', 10),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      database: process.env.DB_NAME || 'wa_gateway',
      waitForConnections: true,
      connectionLimit: 10,
      maxIdle: 5,
      idleTimeout: 60000,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000
    });
  }
  return pool;
}

async function initDatabase() {
  const p = getPool();

  // Auto-create wa_gw_auth table if not exists
  await p.query(`
    CREATE TABLE IF NOT EXISTS \`wa_gw_auth\` (
      \`session_key\` VARCHAR(128) NOT NULL,
      \`key_name\` VARCHAR(191) NOT NULL,
      \`value\` LONGTEXT NOT NULL,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`session_key\`, \`key_name\`),
      INDEX \`idx_session_key\` (\`session_key\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Auto-create wa_gw_msgmap table if not exists
  await p.query(`
    CREATE TABLE IF NOT EXISTS \`wa_gw_msgmap\` (
      \`message_id\` VARCHAR(191) NOT NULL,
      \`session_key\` VARCHAR(128) NOT NULL,
      \`client_ref\` VARCHAR(191) NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`message_id\`),
      INDEX \`idx_session_msg\` (\`session_key\`),
      INDEX \`idx_created_at\` (\`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  logger.info('MySQL database tables verified / initialized successfully');
}

module.exports = {
  getPool,
  initDatabase
};
