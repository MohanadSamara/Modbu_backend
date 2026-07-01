-- ============================================================================
-- Low-Level Roles & Fine-Grained Access — migration
-- ----------------------------------------------------------------------------
-- Run this AFTER SQL-auth-tables.sql. It is additive and backward-compatible:
-- existing roles/permissions keep working unchanged.
--
-- Two things this migration enables:
--
--   1. FINER PERMISSIONS
--      The old 'device.control' permission bundled START and STOP together.
--      This adds separate 'device.start' and 'device.stop' keys so you can
--      build a "low-level" role that can do exactly ONE action (e.g. a role
--      that may START a generator but not STOP it). 'device.control' is kept
--      as a legacy super-key — anyone who has it still passes start/stop.
--
--   2. PER-DEVICE / PER-LOCATION SCOPE
--      user_roles already had project_id (NULL = global). This adds
--      location_id and device_id so a role assignment can be scoped all the
--      way down to a single location or a single device — not just a whole
--      project.
--
-- Scope precedence used by the API (auth.js):
--   global (all NULL)  ⊇  project_id  ⊇  location_id  ⊇  device_id
--   A grant at a broader level automatically covers everything beneath it.
-- ============================================================================


-- ============================================================================
-- 1. user_roles — add location_id + device_id scope columns
-- ============================================================================
ALTER TABLE MODBUS_ADMIN.user_roles ADD (
    location_id NUMBER(10),   -- NULL unless the grant is scoped to one location
    device_id   NUMBER(10)    -- NULL unless the grant is scoped to one device
);

ALTER TABLE MODBUS_ADMIN.user_roles ADD CONSTRAINT fk_ur_location
    FOREIGN KEY (location_id) REFERENCES MODBUS_ADMIN.locations(id)  ON DELETE CASCADE;

ALTER TABLE MODBUS_ADMIN.user_roles ADD CONSTRAINT fk_ur_device
    FOREIGN KEY (device_id)   REFERENCES MODBUS_ADMIN.devices(device_id) ON DELETE CASCADE;

COMMENT ON COLUMN MODBUS_ADMIN.user_roles.location_id IS 'NULL = not location-scoped; otherwise role applies only within this location';
COMMENT ON COLUMN MODBUS_ADMIN.user_roles.device_id   IS 'NULL = not device-scoped; otherwise role applies only to this device';

-- The old unique index only covered (user_id, role_id, project_id). Replace it
-- with one that also distinguishes location/device scope, so the same role can
-- be granted to a user once per distinct scope. NVL(...,0) makes the NULL
-- (unscoped) case unique too, since Oracle treats NULLs as not-equal.
DROP INDEX MODBUS_ADMIN.uq_user_roles_scope;

CREATE UNIQUE INDEX MODBUS_ADMIN.uq_user_roles_scope
    ON MODBUS_ADMIN.user_roles (
        user_id, role_id,
        NVL(project_id, 0), NVL(location_id, 0), NVL(device_id, 0)
    );

CREATE INDEX idx_user_roles_location ON MODBUS_ADMIN.user_roles(location_id);
CREATE INDEX idx_user_roles_device   ON MODBUS_ADMIN.user_roles(device_id);


-- ============================================================================
-- 2. Finer device-control permissions
-- ----------------------------------------------------------------------------
-- Insert only if missing (safe to re-run).
-- ============================================================================
INSERT INTO MODBUS_ADMIN.permissions (permission_key, description)
SELECT 'device.start', 'Send START command to a device'
  FROM dual
 WHERE NOT EXISTS (SELECT 1 FROM MODBUS_ADMIN.permissions WHERE permission_key = 'device.start');

INSERT INTO MODBUS_ADMIN.permissions (permission_key, description)
SELECT 'device.stop', 'Send STOP command to a device'
  FROM dual
 WHERE NOT EXISTS (SELECT 1 FROM MODBUS_ADMIN.permissions WHERE permission_key = 'device.stop');


-- ============================================================================
-- 3. Back-fill: any role that already had the bundled 'device.control'
--    keeps the same power by also getting the two granular keys.
--    (admin + operator in the default seed.)
-- ============================================================================
INSERT INTO MODBUS_ADMIN.role_permissions (role_id, permission_id)
SELECT rp.role_id, p_new.permission_id
  FROM MODBUS_ADMIN.role_permissions rp
  JOIN MODBUS_ADMIN.permissions p_old ON p_old.permission_id = rp.permission_id
                                     AND p_old.permission_key = 'device.control'
  JOIN MODBUS_ADMIN.permissions p_new ON p_new.permission_key IN ('device.start','device.stop')
 WHERE NOT EXISTS (
        SELECT 1 FROM MODBUS_ADMIN.role_permissions x
         WHERE x.role_id = rp.role_id AND x.permission_id = p_new.permission_id
       );

COMMIT;
