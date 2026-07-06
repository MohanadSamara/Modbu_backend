-- ============================================================================
-- SQL-location-perms.sql — add location-level permissions to an EXISTING DB.
--
-- Adds two new permission keys and back-fills them onto roles that already
-- manage projects, so nothing loses access:
--   • any role with 'project.read'  also gets 'location.read'
--   • any role with 'project.write' also gets 'location.write'
--
-- Safe to re-run (every statement is guarded by NOT EXISTS).
-- Run as the schema owner, e.g.:  sqlplus MODBUS_ADMIN/****@db @SQL-location-perms.sql
-- ============================================================================

-- ── 1. New permission keys ─────────────────────────────────────────────────
INSERT INTO MODBUS_ADMIN.permissions (permission_key, description)
SELECT 'location.read', 'View locations'
  FROM dual
 WHERE NOT EXISTS (SELECT 1 FROM MODBUS_ADMIN.permissions WHERE permission_key = 'location.read');

INSERT INTO MODBUS_ADMIN.permissions (permission_key, description)
SELECT 'location.write', 'Create/update/delete locations'
  FROM dual
 WHERE NOT EXISTS (SELECT 1 FROM MODBUS_ADMIN.permissions WHERE permission_key = 'location.write');

-- ── 2. Back-fill: roles that can read projects can read locations ───────────
INSERT INTO MODBUS_ADMIN.role_permissions (role_id, permission_id)
SELECT rp.role_id, p_new.permission_id
  FROM MODBUS_ADMIN.role_permissions rp
  JOIN MODBUS_ADMIN.permissions p_old ON p_old.permission_id = rp.permission_id
                                     AND p_old.permission_key = 'project.read'
  JOIN MODBUS_ADMIN.permissions p_new ON p_new.permission_key = 'location.read'
 WHERE NOT EXISTS (
        SELECT 1 FROM MODBUS_ADMIN.role_permissions x
         WHERE x.role_id = rp.role_id AND x.permission_id = p_new.permission_id
       );

-- ── 3. Back-fill: roles that can write projects can write locations ─────────
INSERT INTO MODBUS_ADMIN.role_permissions (role_id, permission_id)
SELECT rp.role_id, p_new.permission_id
  FROM MODBUS_ADMIN.role_permissions rp
  JOIN MODBUS_ADMIN.permissions p_old ON p_old.permission_id = rp.permission_id
                                     AND p_old.permission_key = 'project.write'
  JOIN MODBUS_ADMIN.permissions p_new ON p_new.permission_key = 'location.write'
 WHERE NOT EXISTS (
        SELECT 1 FROM MODBUS_ADMIN.role_permissions x
         WHERE x.role_id = rp.role_id AND x.permission_id = p_new.permission_id
       );

COMMIT;

-- ── Verify (optional) ───────────────────────────────────────────────────────
-- SELECT permission_key, description FROM MODBUS_ADMIN.permissions
--  WHERE permission_key LIKE 'location.%';
