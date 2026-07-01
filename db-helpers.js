const oracledb = require('oracledb');
const { getConnection } = require('./db');

async function query(sql, binds = [], options = {}) {
  const connection = await getConnection();
  if (!connection) return [];
  try {
    const result = await connection.execute(sql, binds, { ...options, outFormat: oracledb.OUT_FORMAT_OBJECT });
    return result.rows || [];
  } catch (err) {
    console.error(`Query failed: ${err.message}`);
    throw err;
  } finally {
    await connection.close();
  }
}

async function execute(sql, binds = [], options = { autoCommit: true }) {
  const connection = await getConnection();
  if (!connection) throw new Error('DB unavailable');
  try {
    const result = await connection.execute(sql, binds, options);
    if (options.autoCommit !== false) await connection.commit();
    return result;
  } catch (err) {
    if (connection) await connection.rollback().catch(() => {});
    console.error(`Execute failed: ${err.message}`);
    throw err;
  } finally {
    await connection.close();
  }
}

module.exports = { query, execute };

