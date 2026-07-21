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
const { authenticate, requirePermission, invalidateEndpointCache } = require('./middleware');
const { getConnection, restoreDefaultPermissions, restoreDefaultRolePermissions, ensureUiElementCatalog } = require('./db');
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

    // Grant a role: provided roleKey, otherwise default to 'viewer'. The
    // role's own scope/level is copied in — the admin doesn't pick one.
    const targetRoleKey = roleKey || 'viewer';
    await conn.execute(
      `INSERT INTO MODBUS_ADMIN.user_roles
         (user_id, role_id, project_id, location_id, device_id, granted_by)
       SELECT :newUserId, r.role_id, r.scope_project_id, r.scope_location_id, r.scope_device_id, :grantedBy
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

  // The role provides the DEFAULT level/target, but the same role can be given
  // to different users on different targets. So: if the caller supplies a
  // specific target (projectId | locationId | deviceId) we use it; otherwise we
  // fall back to whatever the role has stored. A grant is scoped to at most one
  // level, so reject a mix.
  const provided = [projectId, locationId, deviceId].filter(v => v !== undefined && v !== null && v !== '');
  if (provided.length > 1) {
    return res.status(400).json({ error: 'Provide only one of projectId, locationId, or deviceId' });
  }
  const overrideGiven = provided.length === 1;

  const conn = await getConnection();
  if (!conn) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const roleRes = await conn.execute(
      `SELECT role_id, scope_project_id, scope_location_id, scope_device_id
         FROM MODBUS_ADMIN.roles WHERE role_key = :rk`,
      { rk: roleKey }
    );
    if (!roleRes.rows?.length) return res.status(404).json({ error: 'Unknown roleKey' });
    const [roleId, roleProj, roleLoc, roleDev] = roleRes.rows[0];

    // Effective scope: caller's override if given, else the role's own scope.
    const eff = overrideGiven
      ? {
          projectId:  projectId  ? Number(projectId)  : null,
          locationId: locationId ? Number(locationId) : null,
          deviceId:   deviceId   ? Number(deviceId)   : null,
        }
      : { projectId: roleProj, locationId: roleLoc, deviceId: roleDev };

    await conn.execute(
      `INSERT INTO MODBUS_ADMIN.user_roles
         (user_id, role_id, project_id, location_id, device_id, granted_by)
       VALUES (:userId, :rid, :projectId, :locationId, :deviceId, :grantedBy)`,
      {
        userId: id,
        rid: roleId,
        projectId:  eff.projectId,
        locationId: eff.locationId,
        deviceId:   eff.deviceId,
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
// Each role now carries its own scope "level" (global/project/location/device)
// plus the target it points at. We resolve the target's name so the UI can
// show e.g. "Device: Pump-3" instead of a bare id.
router.get('/roles', requirePermission('user.read'), async (_req, res) => {
  try {
    const rows = await query(
      `SELECT r.role_id, r.role_key, r.role_name, r.description, r.is_system,
              r.scope_level, r.scope_project_id, r.scope_location_id, r.scope_device_id,
              r.scope_count,
              p.name  AS project_name,
              l.name  AS location_name,
              d.device_name AS device_name
         FROM MODBUS_ADMIN.roles r
         LEFT JOIN MODBUS_ADMIN.projects  p ON p.id        = r.scope_project_id
         LEFT JOIN MODBUS_ADMIN.locations l ON l.id        = r.scope_location_id
         LEFT JOIN MODBUS_ADMIN.devices   d ON d.device_id = r.scope_device_id
        ORDER BY r.role_key`
    );
    res.json(rows.map(r => ({
      id:          r.ROLE_ID,
      key:         r.ROLE_KEY,
      name:        r.ROLE_NAME,
      description: r.DESCRIPTION,
      isSystem:    r.IS_SYSTEM === 1,
      scopeLevel:      r.SCOPE_LEVEL || 'global',
      scopeProjectId:  r.SCOPE_PROJECT_ID,
      scopeLocationId: r.SCOPE_LOCATION_ID,
      scopeDeviceId:   r.SCOPE_DEVICE_ID,
      scopeCount:      r.SCOPE_COUNT ?? null,
      scopeTargetName: r.PROJECT_NAME || r.LOCATION_NAME || r.DEVICE_NAME || null,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/roles/reset ── restore system roles' default permission sets ──
// Ensures the three built-in system roles exist and resets each one's granted
// permissions back to its default set. Custom roles are left untouched.
// Registered before the /roles/:id/* routes so 'reset' isn't read as an id.
router.post('/roles/reset', requirePermission('user.assign_role'), async (_req, res) => {
  const r = await restoreDefaultRolePermissions();
  if (!r.ok) return res.status(500).json({ error: r.error || 'Reset failed' });
  invalidateUserPermsCache();
  res.json({ success: true });
});

// Built-in permission keys — referenced directly in backend route guards and
// frontend gates. They can be re-described but NOT renamed or deleted from the
// UI, since removing them would silently break access checks.
const BUILTIN_PERMISSION_KEYS = new Set([
  'device.read', 'device.write', 'device.connect', 'device.control',
  'device.start', 'device.stop',
  'fuel.read', 'alarm.read',
  'project.read', 'project.write',
  'location.read', 'location.write',
  'settings.read', 'settings.write',
  'user.read', 'user.write', 'user.assign_role',
  'audit.read',
]);

// ── GET /api/permissions ──────────────────────────────────────────────────
router.get('/permissions', requirePermission('user.read'), async (_req, res) => {
  try {
    const rows = await query(
      `SELECT permission_id, permission_key, description, resource_type, access_level
         FROM MODBUS_ADMIN.permissions ORDER BY permission_key`
    );
    res.json(rows.map(r => ({
      id:          r.PERMISSION_ID,
      key:         r.PERMISSION_KEY,
      description: r.DESCRIPTION,
      resource:    r.RESOURCE_TYPE || null,
      action:      r.ACCESS_LEVEL || null,
      isBuiltin:   BUILTIN_PERMISSION_KEYS.has(r.PERMISSION_KEY),
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/permissions ── create a new permission key ──────────────────
router.post('/permissions', requirePermission('user.assign_role'), async (req, res) => {
  const key = String(req.body?.permissionKey || '').trim();
  const description = req.body?.description != null ? String(req.body.description).trim() : null;
  // Keys follow '<resource>.<action>' — lowercase letters, digits, dot, underscore.
  if (!/^[a-z][a-z0-9_]*\.[a-z0-9_]+$/.test(key)) {
    return res.status(400).json({ error: "permissionKey must look like 'resource.action' (lowercase, e.g. report.export)" });
  }
  if (key.length > 80) return res.status(400).json({ error: 'permissionKey too long (max 80)' });
  // Derive resource/action from the key ('report.export' → report / export).
  const dot = key.indexOf('.');
  const resource = dot > 0 ? key.slice(0, dot) : null;
  const action = dot > 0 ? key.slice(dot + 1) : null;
  try {
    const r = await execute(
      `INSERT INTO MODBUS_ADMIN.permissions (permission_key, description, resource_type, access_level)
       VALUES (:k, :d, :r, :a)`,
      { k: key, d: description, r: resource, a: action }
    );
    res.status(201).json({ success: true, rowsAffected: r.rowsAffected || 0 });
  } catch (e) {
    if (/UQ_PERMISSIONS_KEY|unique constraint/i.test(e.message)) {
      return res.status(409).json({ error: 'A permission with that key already exists' });
    }
    console.error('POST /api/permissions error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/permissions/reset ── restore built-in permissions + defaults ─
// Deletes every custom permission key, restores the built-in ones, re-seeds the
// UI element catalog, and rebuilds the default permission → UI-element mappings.
router.post('/permissions/reset', requirePermission('user.assign_role'), async (_req, res) => {
  // Make sure the catalog exists so the default element mappings resolve.
  await ensureUiElementCatalog();
  const r = await restoreDefaultPermissions();
  if (!r.ok) return res.status(500).json({ error: r.error || 'Reset failed' });
  invalidateUserPermsCache();
  invalidateEndpointCache();
  res.json({ success: true });
});

// ── PUT /api/permissions/:id ── edit description / resource / action ──────
router.put('/permissions/:id', requirePermission('user.assign_role'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid permission id' });

  const sets = [];
  const binds = { id };
  const clean = (v) => (v == null ? null : String(v).trim() || null);
  if (req.body?.description !== undefined) { sets.push('description = :d');   binds.d = clean(req.body.description); }
  if (req.body?.resource    !== undefined) { sets.push('resource_type = :r'); binds.r = clean(req.body.resource); }
  if (req.body?.action      !== undefined) { sets.push('access_level = :a');  binds.a = clean(req.body.action); }
  if (sets.length === 0) return res.status(400).json({ error: 'nothing to update' });

  try {
    const r = await execute(
      `UPDATE MODBUS_ADMIN.permissions SET ${sets.join(', ')} WHERE permission_id = :id`,
      binds
    );
    if ((r.rowsAffected || 0) === 0) return res.status(404).json({ error: 'Permission not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/permissions/:id/endpoints ── routes this permission protects ──
router.get('/permissions/:id/endpoints', requirePermission('user.read'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid permission id' });
  try {
    const rows = await query(
      `SELECT e.endpoint_id, e.http_method, e.path_pattern
         FROM MODBUS_ADMIN.permission_endpoints e
         JOIN MODBUS_ADMIN.permissions p ON p.permission_key = e.permission_key
        WHERE p.permission_id = :id
        ORDER BY e.path_pattern`,
      { id }
    );
    res.json(rows.map(r => ({
      id:         r.ENDPOINT_ID,
      httpMethod: r.HTTP_METHOD,
      pathPattern: r.PATH_PATTERN,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/permissions/:id/endpoints ── protect a route with it ─────────
router.post('/permissions/:id/endpoints', requirePermission('user.assign_role'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid permission id' });
  const method = String(req.body?.httpMethod || 'ANY').toUpperCase();
  const pathPattern = String(req.body?.pathPattern || '').trim();
  if (!['ANY', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    return res.status(400).json({ error: 'httpMethod must be ANY/GET/POST/PUT/DELETE/PATCH' });
  }
  if (!/^\/[A-Za-z0-9_\-/:.]+$/.test(pathPattern)) {
    return res.status(400).json({ error: "pathPattern must be a path like /api/reports or /api/locations/:id" });
  }
  try {
    const keyRows = await query(
      `SELECT permission_key FROM MODBUS_ADMIN.permissions WHERE permission_id = :id`,
      { id }
    );
    if (!keyRows.length) return res.status(404).json({ error: 'Permission not found' });
    await execute(
      `INSERT INTO MODBUS_ADMIN.permission_endpoints (permission_key, http_method, path_pattern)
       VALUES (:k, :m, :p)`,
      { k: keyRows[0].PERMISSION_KEY, m: method, p: pathPattern }
    );
    invalidateEndpointCache();
    res.status(201).json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/permission-endpoints/:endpointId ── stop protecting a route ─
router.delete('/permission-endpoints/:endpointId', requirePermission('user.assign_role'), async (req, res) => {
  const eid = parseInt(req.params.endpointId);
  if (!Number.isInteger(eid) || eid <= 0) return res.status(400).json({ error: 'Invalid endpoint id' });
  try {
    const r = await execute(
      `DELETE FROM MODBUS_ADMIN.permission_endpoints WHERE endpoint_id = :eid`,
      { eid }
    );
    if ((r.rowsAffected || 0) === 0) return res.status(404).json({ error: 'Endpoint mapping not found' });
    invalidateEndpointCache();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Permission → UI element mappings ──────────────────────────────────────
// Which granular UI elements (buttons/controls — see the frontend catalog in
// config/uiElements.js) a permission covers. Many-to-many: an element may be
// listed under several permissions. Whether a covered element is usable vs
// view-only is decided on the client by the permission's OWN access level
// (read = view only, anything else = usable).

// GET /api/ui-elements — every mapping (element_id + the permission covering
// it). Readable by any authenticated user so the UI can gate live controls.
router.get('/ui-elements', async (_req, res) => {
  try {
    const rows = await query(
      `SELECT element_id, permission_key FROM MODBUS_ADMIN.permission_ui_elements`
    );
    res.json(rows.map(r => ({
      elementId: r.ELEMENT_ID,
      permissionKey: r.PERMISSION_KEY,
    })));
  } catch (e) {
    // If the table doesn't exist yet, behave as "no mappings".
    if (/ORA-00942/i.test(e.message)) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

// ── UI element catalog ─────────────────────────────────────────────────────
// The master list of granular UI elements (buttons/controls), grouped by field.
// Seeded by SQL-ui-element-catalog.sql; editable so typed-in elements persist.

// GET /api/ui-element-catalog — the full catalog, ordered for display. Readable
// by any authenticated user so the Permissions editor can render it.
router.get('/ui-element-catalog', async (_req, res) => {
  try {
    const rows = await query(
      `SELECT element_id, field, label, sort_order
         FROM MODBUS_ADMIN.ui_element_catalog
        ORDER BY sort_order, field, element_id`
    );
    res.json(rows.map(r => ({ 
      id: r.ELEMENT_ID, 
      field: r.FIELD, 
      label: r.LABEL,
      sortOrder: r.SORT_ORDER 
    })));
  } catch (e) {
    if (/ORA-00942/i.test(e.message)) return res.json([]); // table not created yet
    res.status(500).json({ error: e.message });
  }
});

// POST /api/ui-element-catalog { id, field?, label?, sortOrder? } — add or update a catalog
// element (used to persist a typed-in element so it becomes a reusable checkbox).
router.post('/ui-element-catalog', requirePermission('user.assign_role'), async (req, res) => {
  const id = String(req.body?.id || '').trim();
  if (!id || id.length > 60 || !/^[a-z][a-z0-9_.]*$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid element id' });
  }
  const field = (String(req.body?.field || '').trim() || id.split('.')[0] || 'other').slice(0, 40);
  const label = (String(req.body?.label || '').trim() || id).slice(0, 200);
  const sortOrder = parseInt(req.body?.sortOrder) || 999;
  try {
    await execute(
      `MERGE INTO MODBUS_ADMIN.ui_element_catalog t
         USING (SELECT :id AS element_id FROM dual) s
         ON (t.element_id = s.element_id)
       WHEN MATCHED THEN UPDATE SET field = :field, label = :label, sort_order = :sortOrder
       WHEN NOT MATCHED THEN
         INSERT (element_id, field, label, sort_order) VALUES (:id, :field, :label, :sortOrder)`,
      { id, field, label, sortOrder }
    );
    res.status(201).json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/ui-element-catalog/:id — delete a UI element from catalog
router.delete('/ui-element-catalog/:id', requirePermission('user.assign_role'), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id || id.length > 60) {
    return res.status(400).json({ error: 'Invalid element id' });
  }
  try {
    const result = await execute(
      `DELETE FROM MODBUS_ADMIN.ui_element_catalog WHERE element_id = :id`,
      { id }
    );
    if ((result.rowsAffected || 0) === 0) {
      return res.status(404).json({ error: 'Element not found' });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/permissions/:id/elements — element ids this permission covers.
router.get('/permissions/:id/elements', requirePermission('user.read'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid permission id' });
  try {
    const rows = await query(
      `SELECT m.element_id
         FROM MODBUS_ADMIN.permission_ui_elements m
         JOIN MODBUS_ADMIN.permissions p ON p.permission_key = m.permission_key
        WHERE p.permission_id = :id
        ORDER BY m.element_id`,
      { id }
    );
    res.json(rows.map(r => r.ELEMENT_ID));
  } catch (e) {
    if (/ORA-00942/i.test(e.message)) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/permissions/:id/elements { elementId } — cover an element.
router.post('/permissions/:id/elements', requirePermission('user.assign_role'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid permission id' });
  const elementId = String(req.body?.elementId || '').trim();
  if (!elementId || elementId.length > 60 || !/^[a-z][a-z0-9_.]*$/i.test(elementId)) {
    return res.status(400).json({ error: 'Invalid elementId' });
  }
  try {
    const keyRows = await query(
      `SELECT permission_key FROM MODBUS_ADMIN.permissions WHERE permission_id = :id`,
      { id }
    );
    if (!keyRows.length) return res.status(404).json({ error: 'Permission not found' });
    await execute(
      `MERGE INTO MODBUS_ADMIN.permission_ui_elements t
         USING (SELECT :k AS permission_key, :e AS element_id FROM dual) s
         ON (t.permission_key = s.permission_key AND t.element_id = s.element_id)
       WHEN NOT MATCHED THEN
         INSERT (permission_key, element_id) VALUES (s.permission_key, s.element_id)`,
      { k: keyRows[0].PERMISSION_KEY, e: elementId }
    );
    res.status(201).json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/permissions/:id/elements/:elementId — stop covering an element.
router.delete('/permissions/:id/elements/:elementId', requirePermission('user.assign_role'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid permission id' });
  const elementId = String(req.params.elementId || '').trim();
  try {
    const r = await execute(
      `DELETE FROM MODBUS_ADMIN.permission_ui_elements
        WHERE element_id = :e
          AND permission_key = (
            SELECT permission_key FROM MODBUS_ADMIN.permissions WHERE permission_id = :id
          )`,
      { e: elementId, id }
    );
    if ((r.rowsAffected || 0) === 0) return res.status(404).json({ error: 'Element mapping not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/permissions/:id ── remove a custom permission ─────────────
router.delete('/permissions/:id', requirePermission('user.assign_role'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid permission id' });
  try {
    // Look up the key so we can protect built-ins.
    const rows = await query(
      `SELECT permission_key FROM MODBUS_ADMIN.permissions WHERE permission_id = :id`,
      { id }
    );
    if (!rows.length) return res.status(404).json({ error: 'Permission not found' });
    if (BUILTIN_PERMISSION_KEYS.has(rows[0].PERMISSION_KEY)) {
      return res.status(400).json({ error: 'Built-in permissions cannot be deleted' });
    }
    // role_permissions rows cascade automatically (ON DELETE CASCADE).
    await execute(`DELETE FROM MODBUS_ADMIN.permissions WHERE permission_id = :id`, { id });
    invalidateUserPermsCache();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── UI feature → permission overrides ─────────────────────────────────────
// Which permission reveals a UI feature (nav link, button, page). A row with a
// NULL permission_key means "always visible"; no row means "use the frontend's
// built-in default". Readable by any authenticated user (the UI needs it to
// render); editable only with user.assign_role.

// GET /api/ui-features — list overrides
router.get('/ui-features', async (_req, res) => {
  try {
    const rows = await query(
      `SELECT feature_id, permission_key FROM MODBUS_ADMIN.ui_feature_permissions`
    );
    res.json(rows.map(r => ({
      featureId: r.FEATURE_ID,
      permissionKey: r.PERMISSION_KEY || null,
    })));
  } catch (e) {
    // If the table doesn't exist yet, behave as "no overrides".
    if (/ORA-00942/i.test(e.message)) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/ui-features/:featureId — set the controlling permission (or null)
router.put('/ui-features/:featureId', requirePermission('user.assign_role'), async (req, res) => {
  const featureId = String(req.params.featureId || '').trim();
  if (!featureId || featureId.length > 60) return res.status(400).json({ error: 'Invalid featureId' });
  const permissionKey = req.body?.permissionKey ? String(req.body.permissionKey).trim() : null;
  try {
    await execute(
      `MERGE INTO MODBUS_ADMIN.ui_feature_permissions t
         USING (SELECT :fid AS feature_id FROM dual) s
         ON (t.feature_id = s.feature_id)
       WHEN MATCHED THEN UPDATE SET t.permission_key = :pk
       WHEN NOT MATCHED THEN INSERT (feature_id, permission_key) VALUES (:fid, :pk)`,
      { fid: featureId, pk: permissionKey }
    );
    res.json({ success: true });
  } catch (e) {
    if (/ORA-02291/i.test(e.message)) return res.status(400).json({ error: 'Unknown permission key' });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/ui-features/:featureId — reset to the built-in default
router.delete('/ui-features/:featureId', requirePermission('user.assign_role'), async (req, res) => {
  const featureId = String(req.params.featureId || '').trim();
  try {
    await execute(
      `DELETE FROM MODBUS_ADMIN.ui_feature_permissions WHERE feature_id = :fid`,
      { fid: featureId }
    );
    res.json({ success: true });
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

// Normalize a role's scope from a request body. A role applies at exactly one
// level; only the matching target id is kept, everything else is nulled.
function normalizeScope(body = {}) {
  const level = ['global', 'project', 'location', 'device'].includes(body.scopeLevel)
    ? body.scopeLevel : 'global';
  const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
  // The target on a role is OPTIONAL. A role can declare just its level (e.g.
  // "project-level") and leave the specific project blank — the actual target
  // is then chosen per user when the role is assigned. A target may still be
  // set here to act as a default.
  // scope_count: how many of the level's entity this role covers. A positive
  // integer (>= 1) for scoped levels; null for global (nothing to count).
  let count = num(body.scopeCount);
  if (level === 'global') {
    count = null;
  } else if (count === null || !Number.isFinite(count) || count < 1) {
    count = 1;
  } else {
    count = Math.floor(count);
  }

  return {
    scopeLevel: level,
    scopeProjectId:  level === 'project'  ? num(body.scopeProjectId)  : null,
    scopeLocationId: level === 'location' ? num(body.scopeLocationId) : null,
    scopeDeviceId:   level === 'device'   ? num(body.scopeDeviceId)   : null,
    scopeCount: count,
  };
}

// ── POST /api/roles ── create custom role ─────────────────────────────────
router.post('/roles', requirePermission('user.assign_role'), async (req, res) => {
  const { roleKey, roleName, description, permissions } = req.body || {};
  if (!roleKey || roleKey.length < 2) return res.status(400).json({ error: 'roleKey (>=2 chars) required' });
  if (!roleName || roleName.length < 2) return res.status(400).json({ error: 'roleName (>=2 chars) required' });

  const scope = normalizeScope(req.body);
  if (scope.error) return res.status(400).json({ error: scope.error });

  const conn = await getConnection();
  if (!conn) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const insRes = await conn.execute(
      `INSERT INTO MODBUS_ADMIN.roles
         (role_key, role_name, description, is_system,
          scope_level, scope_project_id, scope_location_id, scope_device_id, scope_count)
       VALUES (:rk, :rn, :rd, 0, :sl, :spid, :slid, :sdid, :scnt)
       RETURNING role_id INTO :outId`,
      {
        rk: roleKey,
        rn: roleName,
        rd: description || null,
        sl:   scope.scopeLevel,
        spid: scope.scopeProjectId,
        slid: scope.scopeLocationId,
        sdid: scope.scopeDeviceId,
        scnt: scope.scopeCount,
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
    if (/ORA-02291/i.test(e.message)) return res.status(400).json({ error: 'Invalid scope target (project/location/device not found)' });
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

  // Scope/level is editable for every role (system + custom). Only touch the
  // scope columns when a scopeLevel was supplied so callers can still do a
  // name-only update.
  if (req.body && req.body.scopeLevel !== undefined) {
    const scope = normalizeScope(req.body);
    if (scope.error) return res.status(400).json({ error: scope.error });
    updates.push('scope_level = :sl', 'scope_project_id = :spid',
                 'scope_location_id = :slid', 'scope_device_id = :sdid',
                 'scope_count = :scnt');
    binds.sl   = scope.scopeLevel;
    binds.spid = scope.scopeProjectId;
    binds.slid = scope.scopeLocationId;
    binds.sdid = scope.scopeDeviceId;
    binds.scnt = scope.scopeCount;
  }

  if (updates.length === 0) return res.status(400).json({ error: 'nothing to update' });
  updates.push('updated_at = SYSTIMESTAMP');

  try {
    const r = await execute(
      `UPDATE MODBUS_ADMIN.roles SET ${updates.join(', ')} WHERE role_id = :id`,
      binds
    );
    if ((r.rowsAffected || 0) === 0) return res.status(404).json({ error: 'Role not found' });
    // Changing a role's scope changes what its holders can reach.
    invalidateUserPermsCache();
    res.json({ success: true });
  } catch (e) {
    if (/ORA-02291/i.test(e.message)) return res.status(400).json({ error: 'Invalid scope target (project/location/device not found)' });
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
