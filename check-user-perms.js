/**
 * check-user-perms.js — show every role + permission the given user has.
 *
 * Usage:
 *   node check-user-perms.js          (defaults to "test")
 *   node check-user-perms.js alice
 */

require('dotenv').config();
const { initPool, getConnection, closePool } = require('./db');

const USERNAME = process.argv[2] || 'test';

(async () => {
  const ok = await initPool();
  if (!ok) { console.error('❌ DB pool failed.'); process.exit(1); }
  const conn = await getConnection();
  if (!conn) { console.error('❌ No DB conn.'); await closePool(); process.exit(1); }

  try {
    // 1. Find the user
    const userRes = await conn.execute(
      `SELECT user_id, username, status FROM MODBUS_ADMIN.users WHERE username = :u`,
      { u: USERNAME }
    );
    if (!userRes.rows.length) {
      console.error(`❌ No user named "${USERNAME}".`);
      return;
    }
    const [userId, username, status] = userRes.rows[0];
    console.log(`User: ${username} (id=${userId}, status=${status})\n`);

    // 2. Roles
    const rolesRes = await conn.execute(
      `SELECT ur.user_role_id, r.role_key, r.role_name, ur.project_id, ur.granted_at
         FROM MODBUS_ADMIN.user_roles ur
         JOIN MODBUS_ADMIN.roles      r ON r.role_id = ur.role_id
        WHERE ur.user_id = :userId`,
      { userId }
    );
    console.log(`Roles assigned (${rolesRes.rows.length}):`);
    if (rolesRes.rows.length === 0) {
      console.log('  (none) — this is why the user is denied everything.');
    } else {
      for (const [urid, key, name, projectId, grantedAt] of rolesRes.rows) {
        console.log(`  • ${name} (${key})  scope=${projectId ?? 'GLOBAL'}  user_role_id=${urid}`);
      }
    }

    // 3. Effective permissions (the same query the API uses)
    const permsRes = await conn.execute(
      `SELECT DISTINCT p.permission_key, ur.project_id
         FROM MODBUS_ADMIN.user_roles       ur
         JOIN MODBUS_ADMIN.role_permissions rp ON rp.role_id      = ur.role_id
         JOIN MODBUS_ADMIN.permissions      p  ON p.permission_id = rp.permission_id
         JOIN MODBUS_ADMIN.users            u  ON u.user_id       = ur.user_id
        WHERE u.status   = 'active'
          AND ur.user_id = :userId
        ORDER BY p.permission_key`,
      { userId }
    );
    console.log(`\nEffective permissions (${permsRes.rows.length}):`);
    if (permsRes.rows.length === 0) {
      console.log('  (none)');
    } else {
      for (const [key, projectId] of permsRes.rows) {
        console.log(`  • ${key}  scope=${projectId ?? 'GLOBAL'}`);
      }
    }

    // 4. Quick verdict
    const hasProjectRead = permsRes.rows.some(r => r[0] === 'project.read');
    console.log(
      `\n${hasProjectRead ? '✓' : '❌'} project.read = ${hasProjectRead ? 'YES' : 'NO'}`
    );
    if (!hasProjectRead && rolesRes.rows.length === 0) {
      console.log('\nFix: assign a role. From SQL Developer:');
      console.log(`  INSERT INTO MODBUS_ADMIN.user_roles (user_id, role_id, project_id, granted_by)`);
      console.log(`  SELECT ${userId}, role_id, NULL, 1 FROM MODBUS_ADMIN.roles WHERE role_key = 'viewer';`);
      console.log(`  COMMIT;`);
    }
  } catch (err) {
    console.error('Failed:', err.message);
  } finally {
    await conn.close().catch(() => {});
    await closePool();
  }
})();
