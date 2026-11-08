const { BufferJSON, initAuthCreds } = require('@whiskeysockets/baileys');
const { getPool } = require('./utils/db');
const logger = require('./utils/logger');

// Global registry of flush functions for graceful shutdown
const activeFlushes = new Set();

async function flushAllAuthStates() {
  const promises = [];
  for (const flush of activeFlushes) {
    promises.push(flush());
  }
  await Promise.allSettled(promises);
}

/**
 * Custom MySQL Auth State for Baileys
 * Compatible with useMultiFileAuthState interface
 * Uses table `wa_gw_auth` (session_key, key_name, value LONGTEXT, updated_at)
 * Debounces/batches writes to minimize database load
 */
async function useMySQLAuthState(sessionKey) {
  const pool = getPool();

  // Load existing credentials or initialize new ones
  let creds;
  const [rows] = await pool.query(
    'SELECT `value` FROM `wa_gw_auth` WHERE `session_key` = ? AND `key_name` = ?',
    [sessionKey, 'creds']
  );

  if (rows.length > 0) {
    try {
      creds = JSON.parse(rows[0].value, BufferJSON.reviver);
    } catch (e) {
      logger.warn({ sessionKey, error: e.message }, 'Failed to parse creds from DB, re-initializing');
      creds = initAuthCreds();
    }
  } else {
    creds = initAuthCreds();
  }

  // In-memory write buffer for debouncing writes
  // key -> stringified json value (or null if delete)
  let pendingWrites = new Map();
  let flushTimer = null;

  const flush = async () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    if (pendingWrites.size === 0) return;

    const toWrite = Array.from(pendingWrites.entries());
    pendingWrites = new Map();

    const upserts = [];
    const deletes = [];

    for (const [keyName, value] of toWrite) {
      if (value === null) {
        deletes.push(keyName);
      } else {
        upserts.push([sessionKey, keyName, value]);
      }
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      if (upserts.length > 0) {
        // Batch INSERT ... ON DUPLICATE KEY UPDATE
        const sql = `
          INSERT INTO \`wa_gw_auth\` (\`session_key\`, \`key_name\`, \`value\`)
          VALUES ?
          ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), \`updated_at\` = CURRENT_TIMESTAMP
        `;
        await connection.query(sql, [upserts]);
      }

      if (deletes.length > 0) {
        const placeholders = deletes.map(() => '?').join(',');
        await connection.query(
          `DELETE FROM \`wa_gw_auth\` WHERE \`session_key\` = ? AND \`key_name\` IN (${placeholders})`,
          [sessionKey, ...deletes]
        );
      }

      await connection.commit();
    } catch (err) {
      await connection.rollback();
      logger.error({ sessionKey, error: err.message }, 'Failed to flush MySQL auth state batch');
      // Re-queue writes on failure
      for (const [k, v] of toWrite) {
        if (!pendingWrites.has(k)) {
          pendingWrites.set(k, v);
        }
      }
    } finally {
      connection.release();
    }
  };

  activeFlushes.add(flush);

  const scheduleFlush = () => {
    if (!flushTimer) {
      flushTimer = setTimeout(flush, 500); // 500ms debounce
    }
  };

  const writeData = (key, data) => {
    const serialized = JSON.stringify(data, BufferJSON.replacer);
    pendingWrites.set(key, serialized);
    scheduleFlush();
  };

  const removeData = (key) => {
    pendingWrites.set(key, null);
    scheduleFlush();
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          if (!ids || ids.length === 0) return data;

          const keyNames = ids.map(id => `${type}-${id}`);
          const placeholders = keyNames.map(() => '?').join(',');

          const [keyRows] = await pool.query(
            `SELECT \`key_name\`, \`value\` FROM \`wa_gw_auth\` WHERE \`session_key\` = ? AND \`key_name\` IN (${placeholders})`,
            [sessionKey, ...keyNames]
          );

          // Populate from database
          for (const row of keyRows) {
            try {
              const id = row.key_name.substring(type.length + 1);
              data[id] = JSON.parse(row.value, BufferJSON.reviver);
            } catch (e) {
              logger.warn({ sessionKey, key: row.key_name, error: e.message }, 'Error reviving key');
            }
          }

          // Merge any pending unwritten in-memory changes
          for (const id of ids) {
            const keyName = `${type}-${id}`;
            if (pendingWrites.has(keyName)) {
              const val = pendingWrites.get(keyName);
              if (val === null) {
                delete data[id];
              } else {
                try {
                  data[id] = JSON.parse(val, BufferJSON.reviver);
                } catch (e) {}
              }
            }
          }

          return data;
        },
        set: async (data) => {
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const keyName = `${category}-${id}`;
              if (value) {
                writeData(keyName, value);
              } else {
                removeData(keyName);
              }
            }
          }
        }
      }
    },
    saveCreds: () => {
      writeData('creds', creds);
    },
    flush,
    destroy: async () => {
      activeFlushes.delete(flush);
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pendingWrites.clear();
      await pool.query('DELETE FROM `wa_gw_auth` WHERE `session_key` = ?', [sessionKey]);
    }
  };
}

module.exports = {
  useMySQLAuthState,
  flushAllAuthStates
};
