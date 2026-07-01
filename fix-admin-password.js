/**
 * fix-admin-password.js — one-shot script that sets the admin password
 * to a real bcrypt hash, directly from Node. No SQL Developer needed.
 *
 * Usage:
 *   node fix-admin-password.js               (uses default password)
 *   node fix-admin-password.js MyP@ssw0rd    (uses your password)
 *
 * After running, log in at /login with:
 *   username = admin
 *   password = whatever you passed (or the default below)
 */

require('dotenv').config();
const bcrypt = require('bcrypt');
const { initPool, getConnection, closePool } = require('./db');

const USERNAME = 'admin';
const PASSWORD = process.argv[2] || 'YourNewPassword';

(async () => {
  const ok = await initPool();
  if (!ok) {
    console.error('❌ DB pool failed to initialise. Check ORACLE_* in .env.');
    process.exit(1);
  }

  const conn = await getConnection();
  if (!conn) {
    console.error('❌ Could not acquire DB connection.');
    await closePool();
    process.exit(1);
  }

  try {
    console.log(`Hashing "${PASSWORD}" with bcrypt cost 10…`);
    const hash = await bcrypt.hash(PASSWORD, 10);
    console.log(`  hash: ${hash}`);
    console.log(`  length: ${hash.length} chars (expect 60)\n`);

    console.log(`Updating MODBUS_ADMIN.users WHERE username='${USERNAME}'…`);
    const result = await conn.execute(
      `UPDATE MODBUS_ADMIN.users
          SET password_hash = :hash,
              password_changed_at = SYSTIMESTAMP,
              failed_logins = 0,
              locked_until = NULL,
              status = 'active',
              updated_at = SYSTIMESTAMP
        WHERE username = :u`,
      { hash, u: USERNAME }
    );

    if ((result.rowsAffected || 0) === 0) {
      console.error(`❌ No row matched username='${USERNAME}'.`);
      console.error('   Run: SELECT username FROM MODBUS_ADMIN.users;');
      return;
    }

    await conn.commit();
    console.log(`✓ Updated ${result.rowsAffected} row(s) and committed.\n`);

    // Read it back to prove it stuck
    const verify = await conn.execute(
      `SELECT password_hash, status FROM MODBUS_ADMIN.users WHERE username = :u`,
      { u: USERNAME }
    );
    const [storedHash, status] = verify.rows[0];
    const looksLikeBcrypt = /^\$2[aby]\$\d{2}\$.{53}$/.test(storedHash);

    console.log('Verification:');
    console.log(`  stored hash starts with: ${storedHash.slice(0, 7)}`);
    console.log(`  stored hash length     : ${storedHash.length}`);
    console.log(`  status                 : ${status}`);
    console.log(`  bcrypt format valid    : ${looksLikeBcrypt ? '✓' : '✗'}`);

    const match = await bcrypt.compare(PASSWORD, storedHash);
    console.log(`  bcrypt.compare check   : ${match ? '✓ matches' : '✗ does NOT match'}`);

    if (match && looksLikeBcrypt && status === 'active') {
      console.log('\n🎉 Done. Log in with:');
      console.log(`     username: ${USERNAME}`);
      console.log(`     password: ${PASSWORD}`);
    } else {
      console.log('\n⚠ Something went wrong — see fields above.');
    }
  } catch (err) {
    console.error('Failed:', err.message);
    try { await conn.rollback(); } catch (_) {}
  } finally {
    await conn.close().catch(() => {});
    await closePool();
  }
})();
