/**
 * unlock-user.js — instantly unlock a locked account from Node.
 *
 * Usage:
 *   node unlock-user.js                  (defaults to "admin")
 *   node unlock-user.js alice            (unlocks alice)
 *
 * What it does:
 *   • status        -> 'active'
 *   • failed_logins -> 0
 *   • locked_until  -> NULL
 */

require('dotenv').config();
const { initPool, getConnection, closePool } = require('./db');

const USERNAME = process.argv[2] || 'admin';

(async () => {
  const ok = await initPool();
  if (!ok) {
    console.error('❌ DB pool failed to initialise.');
    process.exit(1);
  }

  const conn = await getConnection();
  if (!conn) {
    console.error('❌ Could not acquire DB connection.');
    await closePool();
    process.exit(1);
  }

  try {
    const result = await conn.execute(
      `UPDATE MODBUS_ADMIN.users
          SET status        = 'active',
              failed_logins = 0,
              locked_until  = NULL,
              updated_at    = SYSTIMESTAMP
        WHERE username = :u`,
      { u: USERNAME },
      { autoCommit: true }
    );

    if ((result.rowsAffected || 0) === 0) {
      console.error(`❌ No user named "${USERNAME}".`);
      return;
    }

    console.log(`✓ Unlocked "${USERNAME}". You can log in immediately.`);

    // Show the row so you can confirm
    const verify = await conn.execute(
      `SELECT username, status, failed_logins, locked_until
         FROM MODBUS_ADMIN.users WHERE username = :u`,
      { u: USERNAME }
    );
    const [name, status, failed, until] = verify.rows[0];
    console.log(`  username       : ${name}`);
    console.log(`  status         : ${status}`);
    console.log(`  failed_logins  : ${failed}`);
    console.log(`  locked_until   : ${until || '(none)'}`);
  } catch (err) {
    console.error('Failed:', err.message);
  } finally {
    await conn.close().catch(() => {});
    await closePool();
  }
})();
