/**
 * test-login.js — diagnose why login isn't working.
 *
 * Run with: node test-login.js
 *
 * It checks, in order:
 *   1. That the admin row exists.
 *   2. What the stored password_hash actually looks like.
 *   3. Whether bcrypt.compare() succeeds for the password we expect.
 *   4. The account status / lock state.
 *
 * Edit USERNAME and PASSWORD below if you used different values.
 */

require('dotenv').config();
const bcrypt = require('bcrypt');
const { initPool, getConnection, closePool } = require('./db');

const USERNAME = 'admin';
const PASSWORD = 'YourNewPassword'; // change this if you used a different password

(async () => {
  console.log('─── Login diagnostic ───');
  console.log(`  username: ${USERNAME}`);
  console.log(`  password: ${PASSWORD}\n`);

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
    // 1. Look up the user — same query the API uses
    const r = await conn.execute(
      `SELECT user_id, username, email, password_hash, full_name, status,
              failed_logins, locked_until
         FROM MODBUS_ADMIN.users
        WHERE LOWER(username) = LOWER(:login)
           OR LOWER(email)    = LOWER(:login)`,
      { login: USERNAME }
    );

    if (!r.rows?.length) {
      console.error(`❌ No user found matching "${USERNAME}". Is the seed row missing?`);
      console.error('   Try: SELECT username FROM MODBUS_ADMIN.users;');
      return;
    }
    if (r.rows.length > 1) {
      console.warn(`⚠ ${r.rows.length} users matched — using the first.`);
    }

    const [userId, username, email, hash, fullName, status, failed, lockedUntil] = r.rows[0];

    console.log('Row found:');
    console.log(`  user_id        : ${userId}`);
    console.log(`  username       : ${username}`);
    console.log(`  email          : ${email}`);
    console.log(`  full_name      : ${fullName}`);
    console.log(`  status         : ${status}`);
    console.log(`  failed_logins  : ${failed}`);
    console.log(`  locked_until   : ${lockedUntil || '(none)'}`);
    console.log(`  password_hash  : ${hash}`);
    console.log(`    length       : ${hash?.length}`);
    console.log(`    starts with  : ${hash?.slice(0, 7)}`);
    console.log();

    // 2. Validate hash shape
    const looksLikeBcrypt = typeof hash === 'string' && /^\$2[aby]\$\d{2}\$.{53}$/.test(hash);
    if (!looksLikeBcrypt) {
      console.error('❌ password_hash is NOT a valid bcrypt hash.');
      console.error('   A real bcrypt hash starts with $2b$10$ (or $2a$/$2y$),');
      console.error('   is exactly 60 chars long, and looks like gibberish.');
      console.error('   Yours looks like plaintext or a malformed value.');
      console.error('\n   Fix it by running:');
      console.error(`     node -e "console.log(require('bcrypt').hashSync('YourPassword', 10))"`);
      console.error('   then UPDATE MODBUS_ADMIN.users SET password_hash = \'<that output>\' WHERE username=\'admin\';');
      console.error('   COMMIT;');
      return;
    }
    console.log('✓ Hash format looks valid (bcrypt $2b$10$… 60 chars).');

    // 3. Compare
    const match = await bcrypt.compare(PASSWORD, hash);
    if (match) {
      console.log(`✓ bcrypt.compare("${PASSWORD}", hash) === true`);
      console.log('\n🎉 Login should work. If the UI still says "Login failed",');
      console.log('   the issue is in the request itself — check the browser network tab.');
    } else {
      console.log(`❌ bcrypt.compare("${PASSWORD}", hash) === false`);
      console.log('   The stored hash is valid bcrypt, but it does NOT match this password.');
      console.log('   Either:');
      console.log('     a) you used a different password when generating the hash, OR');
      console.log('     b) the stored hash is from an older generation.');
      console.log('\n   Re-generate and update:');
      console.log(`     node -e "console.log(require('bcrypt').hashSync('${PASSWORD}', 10))"`);
      console.log('     UPDATE MODBUS_ADMIN.users SET password_hash = \'<output>\' WHERE username=\'admin\';');
      console.log('     COMMIT;');
    }

    // 4. Status check (would block login even with correct password)
    if (status !== 'active') {
      console.log(`\n⚠ status = "${status}" — login will be blocked even with correct password.`);
      console.log('   Run: UPDATE MODBUS_ADMIN.users SET status=\'active\', failed_logins=0, locked_until=NULL WHERE username=\'admin\'; COMMIT;');
    }
    if (lockedUntil && new Date(lockedUntil).getTime() > Date.now()) {
      console.log(`\n⚠ locked_until = ${lockedUntil} (in the future) — account is locked.`);
    }

  } catch (err) {
    console.error('Diagnostic failed:', err.message);
  } finally {
    await conn.close().catch(() => {});
    await closePool();
  }
})();
