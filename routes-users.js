/**
 * routes-users.js — admin user & role management
 *
 *   GET    /api/users                 -> list users           (user.read)
 *   GET    /api/users/:id             -> user + roles         (user.read)
 *   POST   /api/users                 -> create user          (user.write)
 *   PUT    /api/users/:id             -> update user          (user.write)
 *   DELETE /api/users/:id             -> delete user          (user.write)
 *   POST   /api/users/:id/reset-password   { newPassword }    (user.write)
 *   POST   /api/users/:id/lock        -> disable account      (user.write)
 *   POST   /api/users/:id/unlock      -> re-enable account    (user.write)
 *   POST   /api/users/:id/roles       { roleKey, projectId? | locationId? | deviceId? } -> grant role (user.assign_role)
 *   DELETE /api/users/:id/roles/:userRoleId -> revoke role    (user.assign_role)
 *
 *   GET    /api/roles                 -> list roles           (user.read)
 * Roles CRUD:
 *   POST   /api/roles                 -> create role          (user.assign_role)
 *   GET    /api/roles/:id/permissions -> permissions in role  (user.read)
 *   POST   /api/roles/:id/permissions { permissionKey } -> grant  (user.assign_role)
 *   DELETE /api/roles/:id/permissions/:pid -> revoke          (user.assign_role)
 *   PUT    /api/roles/:id             -> update role          (user.assign_role)
 *   DELETE /api/roles/:id             -> delete role          (user.assign_role)
 *
 *   GET    /api/permissions           -> list permissions     (user.read)
 *   GET    /api/audit                 -> recent login audit   (audit.read)
 */

const express = require('express');
const oracledb = require('oracledb');
const router = express.Router();

const { hashPassword, invalidateUserPermsCache, revokeAllSessions } = require('./auth');
const { authenticate, requirePermission } = require('./middleware');
const { getConnection } = require('./db');
const { query, execute } = require('./db-helpers');

// All routes in this file require an authenticated user.
router.use(authenticate);

// ── GET /api/users ────────────────────────────────────────────────────────
router.get('/users', requirePermission('user.read'), async (_req, res) => {
  try {
    const rows = await query(
      `SELECT user_id, username, email, full_name, status,
              last_login_at, created_at, updated_at
         FROM MODBUS_ADMIN.users
        ORDER BY username`
    );
    res.json(rows.map(r => ({
      id:          r.USER_ID,
      username:    r.USERNAME,
      email:       r.EMAIL,
      fullName:    r.FULL_NAME,
      status:      r.STATUS,
      lastLoginAt: r.LAST_LOGIN_AT,
      createdAt:   r.CREATED_AT,
      updatedAt:   r.UPDATED_AT,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/users/:id ────────────────────────────────────────────────────
router.get('/users/:id', requirePermission('user.read'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid user id' });

  try {
    const userRows = await query(
      `SELECT user_id, username, email, full_name, status, last_login_at,
              created_at, updated_at
         FROM MODBUS_ADMIN.users WHERE user_id = :id`,
      [id]
    );
    if (userRows.length === 0) return res.status(404).json({ error: 'User not found' });

    const roleRows = await query(
      `SELECT ur.user_role_id, r.role_key, r.role_name,
              ur.project_id, ur.location_id, ur.device_id, ur.granted_at
         FROM MODBUS_ADMIN.user_roles ur
         JOIN MODBUS_ADMIN.roles      r ON r.role_id = ur.role_id
        WHERE ur.user_id = :id
        ORDER BY r.role_key`,
      [id]
    );

    const u = userRows[0];
    res.json({
      id:          u.USER_ID,
      username:    u.USERNAME,
      email:       u.EMAIL,
      fullName:    u.FULL_NAME,
      status:      u.STATUS,
      lastLoginAt: u.LAST_LOGIN_AT,
      createdAt:   u.CREATED_AT,
      updatedAt:   u.UPDATED_AT,
      roles: roleRows.map(r => ({
        userRoleId: r.USER_ROLE_ID,
        key:        r.ROLE_KEY,
        name:       r.ROLE_NAME,
        projectId:  r.PROJECT_ID,
        locationId: r.LOCATION_ID,
        deviceId:   r.DEVICE_ID,
        grantedAt:  r.GRANTED_AT,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/users — admin creates a user ────────────────────────────────
router.post('/users', requirePermission('user.write'), async (req, res) => {
  const { username, email, password, fullName, status, roleKey } = req.body || {};

  if (!username || username.length < 3) return res.status(400).json({ error: 'username (>=3 chars) required' });
  if (!email    || !/^.+@.+\..+$/.test(email)) return res.status(400).json({ error: 'valid email required' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'password (>=8 chars) required' });

  const conn = await getConnection();
  if (!conn) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const hash = await hashPassword(password);

    const insRes = await conn.execute(
      `INSERT INTO MODBUS_ADMIN.users (username, email, password_hash, full_name, status)
       VALUES (:u, :e, :h, :n, :s)
       RETURNING user_id INTO :outId`,
      {
        u: username,
        e: email,
        h: hash,
        n: fullName || null,
        s: status || 'active',
        outId: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      }
    );
    const newId = insRes.outBinds.outId[0];

    // Grant a role: provided roleKey, otherwise default to 'viewer'
    const targetRoleKey = roleKey || 'viewer';
    await conn.execute(
      `INSERT INTO MODBUS_ADMIN.user_roles (user_id, role_id, project_id, granted_by)
       SELECT :newUserId, r.role_id, NULL, :grantedBy
         FROM MODBUS_ADMIN.roles r
        WHERE r.role_key = :rk`,
      { newUserId: newId, grantedBy: req.user.id, rk: targetRoleKey }
    );

    await conn.commit();
    res.status(201).json({ success: true, id: newId });
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    if (/UQ_USERS_USERNAME/i.test(e.message)) return res.status(409).json({ error: 'username already taken' });
    if (/UQ_USERS_EMAIL/i.test(e.message))    return res.status(409).json({ error: 'email already registered' });
    console.error('POST /api/users error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    await conn.close().catch(() => {});
  }
});

// ── PUT /api/users/:id ────────────────────────────────────────────────────
router.put('/users/:id', requirePermission('user.write'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid user id' });

  const { email, fullName, status } = req.body || {};
  const updates = [];
  const binds = { id };

  if (email    !== undefined) { updates.push('email = :email');         binds.email    = email; }
  if (fullName !== undefined) { updates.push('full_name = :fullName');  binds.fullName = fullName || null; }
  if (status   !== undefined) {
    if (!['active','disabled','locked'].includes(status)) {
      return res.status(400).json({ error: 'status must be active|disabled|locked' });
    }
    updates.push('status = :status');
    binds.status = status;
  }
  if (updates.length === 0) return res.status(400).json({ error: 'nothing to update' });

  updates.push('updated_at = SYSTIMESTAMP');

  try {
    const r = await execute(
      `UPDATE MODBUS_ADMIN.users SET ${updates.join(', ')} WHERE user_id = :id`,
      binds
    );
    if ((r.rowsAffected || 0) === 0) return res.status(404).json({ error: 'User not found' });

    if (status === 'disabled' || status === 'locked') {
      await revokeAllSessions(id); // force-logout if disabled/locked
    }
    invalidateUserPermsCache(id);
    res.json({ success: true });
  } catch (e) {
    if (/UQ_USERS_EMAIL/i.test(e.message)) return res.status(409).json({ error: 'email already registered' });
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/users/:id ─────────────────────────────────────────────────
router.delete('/users/:id', requirePermission('user.write'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid user id' });
  if (id === req.user.id) return res.status(400).json({ error: "You can't delete your own account" });

  try {
    const r = await execute('DELETE FROM MODBUS_ADMIN.users WHERE user_id = :id', { id });
    if ((r.rowsAffected || 0) === 0) return res.status(404).json({ error: 'User not found' });
    invalidateUserPermsCache(id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/users/:id/reset-password ────────────────────────────────────
router.post('/users/:id/reset-password', requirePermission('user.write'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid user id' });
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'newPassword (>=8 chars) required' });
  }
  try {
    const hash = await hashPassword(newPassword);
    const r = await execute(
      `UPDATE MODBUS_ADMIN.users
          SET password_hash = :h, password_changed_at = SYSTIMESTAMP,
              failed_logins = 0, locked_until = NULL,
              status = CASE WHEN status = 'locked' THEN 'active' ELSE status END,
              updated_at = SYSTIMESTAMP
        WHERE user_id = :id`,
      { h: hash, id }
    );
    if ((r.rowsAffected || 0) === 0) return res.status(404).json({ error: 'User not found' });
    await revokeAllSessions(id);
    invalidateUserPermsCache(id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/users/:id/lock & /unlock ────────────────────────────────────
router.post('/users/:id/lock', requirePermission('user.write'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid user id' });
  if (id === req.user.id) return res.status(400).json({ error: "You can't lock your own account" });
  try {
    await execute(
      `UPDATE MODBUS_ADMIN.users SET status = 'disabled', updated_at = SYSTIMESTAMP WHERE user_id = :id`,
      { id }
    );
    await revokeAllSessions(id);
    invalidateUserPermsCache(id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/users/:id/unlock', requirePermission('user.write'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid user id' });
  try {
    await execute(
      `UPDATE MODBUS_ADMIN.users
          SET status = 'active', failed_logins = 0, locked_until = NULL, updated_at = SYSTIMESTAMP
        WHERE user_id = :id`,
      { id }
    );
    invalidateUserPermsCache(id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/users/:id/roles — grant role ────────────────────────────────
router.post('/users/:id/roles', requirePermission('user.assign_role'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid user id' });
  const { roleKey, projectId, locationId, deviceId } = req.body || {};
  if (!roleKey) return res.status(400).json({ error: 'roleKey is required' });

  // A grant is scoped to at most ONE level: global, project, location, or
  // device. Mixing levels is ambiguous, so reject it up front.
  const scopes = [projectId, locationId, deviceId].filter(v => v !== undefined && v !== null && v !== '');
  if (scopes.length > 1) {
    return res.status(400).json({ error: 'Provide only one of projectId, locationId, or deviceId' });
  }

  const conn = await getConnection();
  if (!conn) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const roleRes = await conn.execute(
      `SELECT role_id FROM MODBUS_ADMIN.roles WHERE role_key = :k`,
      { k: roleKey }
    );
    if (!roleRes.rows?.length) return res.status(404).json({ error: 'Unknown roleKey' });
    const roleId = roleRes.rows[0][0];

    await conn.execute(
      `INSERT INTO MODBUS_ADMIN.user_roles (user_id, role_id, project_id, location_id, device_id, granted_by)
       VALUES (:userId, :rid, :projectId, :locationId, :deviceId, :grantedBy)`,
      {
        userId: id,
        rid: roleId,
        projectId:  projectId  || null,
        locationId: locationId || null,
        deviceId:   deviceId   || null,
        grantedBy: req.user.id,
      },
      { autoCommit: true }
    );
    invalidateUserPermsCache(id);
    res.status(201).json({ success: true });
  } catch (e) {
    if (/UQ_USER_ROLES_SCOPE|unique constraint/i.test(e.message)) {
      return res.status(409).json({ error: 'User already has that role with that scope' });
    }
    if (/ORA-02291/i.test(e.message)) {
      return res.status(400).json({ error: 'Invalid user_id, project_id, location_id, or device_id' });
    }
    console.error('POST /api/users/:id/roles error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    await conn.close().catch(() => {});
  }
});

// ── DELETE /api/users/:id/roles/:userRoleId — revoke role ─────────────────
router.delete('/users/:id/roles/:userRoleId', requirePermission('user.assign_role'), async (req, res) => {
  const id  = parseInt(req.params.id);
  const urid = parseInt(req.params.userRoleId);
  if (!Number.isInteger(id) || !Number.isInteger(urid)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  try {
    const r = await execute(
      `DELETE FROM MODBUS_ADMIN.user_roles WHERE user_role_id = :urid AND user_id = :id`,
      { urid, id }
    );
    if ((r.rowsAffected || 0) === 0) return res.status(404).json({ error: 'Role assignment not found' });
    invalidateUserPermsCache(id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/roles ────────────────────────────────────────────────────────
router.get('/roles', requirePermission('user.read'), async (_req, res) => {
  try {
    const rows = await query(
      `SELECT role_id, role_key, role_name, description, is_system
         FROM MODBUS_ADMIN.roles ORDER BY role_key`
    );
    res.json(rows.map(r => ({
      id:          r.ROLE_ID,
      key:         r.ROLE_KEY,
      name:        r.ROLE_NAME,
      description: r.DESCRIPTION,
      isSystem:    r.IS_SYSTEM === 1,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/permissions ──────────────────────────────────────────────────
router.get('/permissions', requirePermission('user.read'), async (_req, res) => {
  try {
    const rows = await query(
      `SELECT permission_id, permission_key, description
         FROM MODBUS_ADMIN.permissions ORDER BY permission_key`
    );
    res.json(rows.map(r => ({
      id:          r.PERMISSION_ID,
      key:         r.PERMISSION_KEY,
      description: r.DESCRIPTION,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/roles/:id/permissions ────────────────────────────────────────
router.get('/roles/:id/permissions', requirePermission('user.read'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid role id' });
  try {
    const rows = await query(
      `SELECT p.permission_id, p.permission_key, p.description, rp.granted_at
         FROM MODBUS_ADMIN.role_permissions rp
         JOIN MODBUS_ADMIN.permissions      p ON p.permission_id = rp.permission_id
        WHERE rp.role_id = :id
        ORDER BY p.permission_key`,
      [id]
    );
    res.json(rows.map(r => ({
      id:          r.PERMISSION_ID,
      key:         r.PERMISSION_KEY,
      description: r.DESCRIPTION,
      grantedAt:   r.GRANTED_AT,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/roles/:id/permissions ── grant permission to role ───────────
router.post('/roles/:id/permissions', requirePermission('user.assign_role'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid role id' });
  const { permissionKey } = req.body || {};
  if (!permissionKey) return res.status(400).json({ error: 'permissionKey is required' });

  const conn = await getConnection();
  if (!conn) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const permRes = await conn.execute(
      `SELECT permission_id FROM MODBUS_ADMIN.permissions WHERE permission_key = :k`,
      { k: permissionKey }
    );
    if (!permRes.rows?.length) return res.status(404).json({ error: 'Unknown permissionKey' });
    const permId = permRes.rows[0][0];

    await conn.execute(
      `INSERT INTO MODBUS_ADMIN.role_permissions (role_id, permission_id) VALUES (:rid, :pid)`,
      { rid: id, pid: permId },
      { autoCommit: true }
    );
    invalidateUserPermsCache(); // broad-bust all permission caches
    res.status(201).json({ success: true });
  } catch (e) {
    if (/unique constraint/i.test(e.message)) {
      return res.status(409).json({ error: 'Role already has that permission' });
    }
    console.error('POST /api/roles/:id/permissions error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    await conn.close().catch(() => {});
  }
});

// ── DELETE /api/roles/:id/permissions/:pid ── revoke permission ───────────
router.delete('/roles/:id/permissions/:pid', requirePermission('user.assign_role'), async (req, res) => {
  const roleId = parseInt(req.params.id);
  const permId = parseInt(req.params.pid);
  if (!Number.isInteger(roleId) || !Number.isInteger(permId)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  try {
    const r = await execute(
      `DELETE FROM MODBUS_ADMIN.role_permissions WHERE role_id = :rid AND permission_id = :pid`,
      { rid: roleId, pid: permId }
    );
    if ((r.rowsAffected || 0) === 0) return res.status(404).json({ error: 'Permission assignment not found' });
    invalidateUserPermsCache();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/roles ── create custom role ─────────────────────────────────
router.post('/roles', requirePermission('user.assign_role'), async (req, res) => {
  const { roleKey, roleName, description, permissions } = req.body || {};
  if (!roleKey || roleKey.length < 2) return res.status(400).json({ error: 'roleKey (>=2 chars) required' });
  if (!roleName || roleName.length < 2) return res.status(400).json({ error: 'roleName (>=2 chars) required' });

  const conn = await getConnection();
  if (!conn) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const insRes = await conn.execute(
      `INSERT INTO MODBUS_ADMIN.roles (role_key, role_name, description, is_system)
       VALUES (:rk, :rn, :rd, 0)
       RETURNING role_id INTO :outId`,
      {
        rk: roleKey,
        rn: roleName,
        rd: description || null,
        outId: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      }
    );
    const newId = insRes.outBinds.outId[0];

    // Assign permissions if provided
    if (permissions && Array.isArray(permissions) && permissions.length > 0) {
      for (const permKey of permissions) {
        const permRes = await conn.execute(
          `SELECT permission_id FROM MODBUS_ADMIN.permissions WHERE permission_key = :k`,
          { k: permKey }
        );
        if (permRes.rows?.length) {
          const permId = permRes.rows[0][0];
          await conn.execute(
            `INSERT INTO MODBUS_ADMIN.role_permissions (role_id, permission_id) VALUES (:rid, :pid)`,
            { rid: newId, pid: permId }
          );
        }
      }
    }

    await conn.commit();
    res.status(201).json({ success: true, id: newId });
  } catch (e) {
    if (/UQ_ROLES_ROLE_KEY/i.test(e.message)) return res.status(409).json({ error: 'roleKey already exists' });
    console.error('POST /api/roles error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    await conn.close().catch(() => {});
  }
});

// ── PUT /api/roles/:id ── update custom role ──────────────────────────────
router.put('/roles/:id', requirePermission('user.assign_role'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid role id' });

  const { roleName, description } = req.body || {};
  const updates = [];
  const binds = { id };
  if (roleName !== undefined) { updates.push('role_name = :rn'); binds.rn = roleName; }
  if (description !== undefined) { updates.push('description = :rd'); binds.rd = description || null; }
  if (updates.length === 0) return res.status(400).json({ error: 'nothing to update' });
  updates.push('updated_at = SYSTIMESTAMP');

  try {
    const r = await execute(
      `UPDATE MODBUS_ADMIN.roles SET ${updates.join(', ')} WHERE role_id = :id`,
      binds
    );
    if ((r.rowsAffected || 0) === 0) return res.status(404).json({ error: 'Role not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/roles/:id ── delete custom role ───────────────────────────
router.delete('/roles/:id', requirePermission('user.assign_role'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid role id' });
  try {
    const r = await execute(
      `DELETE FROM MODBUS_ADMIN.roles WHERE role_id = :id AND is_system = 0`,
      { id }
    );
    if ((r.rowsAffected || 0) === 0) return res.status(404).json({ error: 'Role not found or is a system role' });
    invalidateUserPermsCache();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/audit ────────────────────────────────────────────────────────
router.get('/audit', requirePermission('audit.read'), async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const userId = req.query.user_id ? parseInt(req.query.user_id) : null;

  let sql = `SELECT * FROM (
               SELECT audit_id, user_id, username_try, event_type, ip_address,
                      user_agent, detail, event_time
                 FROM MODBUS_ADMIN.user_login_audit`;
  const binds = {};
  if (userId) {
    sql += ` WHERE user_id = :userId`;
    binds.userId = userId;
  }
  sql += ` ORDER BY event_time DESC) WHERE ROWNUM <= ${limit}`;

  try {
    const rows = await query(sql, binds);
    res.json(rows.map(r => ({
      id:          r.AUDIT_ID,
      userId:      r.USER_ID,
      usernameTry: r.USERNAME_TRY,
      eventType:   r.EVENT_TYPE,
      ip:          r.IP_ADDRESS,
      userAgent:   r.USER_AGENT,
      detail:      r.DETAIL,
      time:        r.EVENT_TIME,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
