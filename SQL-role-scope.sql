-- ============================================================================
-- Role-level scope — migration
-- ----------------------------------------------------------------------------
-- Run this AFTER SQL-auth-tables.sql and SQL-low-level-roles.sql.
--
-- Previously the scope "level" (global / project / location / device) was
-- chosen when an admin ASSIGNED a role to a user (user_roles.project_id /
-- location_id / device_id).
--
-- This migration moves the level ONTO THE ROLE itself. A role now carries:
--   • scope_level      : 'global' | 'project' | 'location' | 'device'
--   • scope_project_id / scope_location_id / scope_device_id : the target
--
-- When the role is granted to a user, the API copies these values into
-- user_roles, so the admin never has to pick a level/target again — choosing
-- the role is enough. The permission-check logic in auth.js is unchanged
-- because it still reads the scope from user_roles.
-- ============================================================================


-- ============================================================================
-- 1. roles — add scope columns
-- ============================================================================
ALTER TABLE MODBUS_ADMIN.roles ADD (
    scope_level       VARCHAR2(20) DEFAULT 'global' NOT NULL,
    scope_project_id  NUMBER(10),
    scope_location_id NUMBER(10),
    scope_device_id   NUMBER(10),
    scope_count       NUMBER(10) DEFAULT 1
);

ALTER TABLE MODBUS_ADMIN.roles
    ADD CONSTRAINT ck_roles_scope_level
    CHECK (scope_level IN ('global','project','location','device'));

ALTER TABLE MODBUS_ADMIN.roles ADD CONSTRAINT fk_roles_scope_project
    FOREIGN KEY (scope_project_id)  REFERENCES MODBUS_ADMIN.projects(id)         ON DELETE SET NULL;

ALTER TABLE MODBUS_ADMIN.roles ADD CONSTRAINT fk_roles_scope_location
    FOREIGN KEY (scope_location_id) REFERENCES MODBUS_ADMIN.locations(id)        ON DELETE SET NULL;

ALTER TABLE MODBUS_ADMIN.roles ADD CONSTRAINT fk_roles_scope_device
    FOREIGN KEY (scope_device_id)   REFERENCES MODBUS_ADMIN.devices(device_id)   ON DELETE SET NULL;

COMMENT ON COLUMN MODBUS_ADMIN.roles.scope_level      IS 'global | project | location | device — the level this role applies at';
COMMENT ON COLUMN MODBUS_ADMIN.roles.scope_project_id IS 'target project when scope_level = project';
COMMENT ON COLUMN MODBUS_ADMIN.roles.scope_location_id IS 'target location when scope_level = location';
COMMENT ON COLUMN MODBUS_ADMIN.roles.scope_device_id  IS 'target device when scope_level = device';
COMMENT ON COLUMN MODBUS_ADMIN.roles.scope_count      IS 'how many of the level entity this role covers (>=1); NULL/1 for global';


-- ============================================================================
-- 2. Existing rows default to 'global' (set by the DEFAULT above). The
--    built-in admin/operator/viewer roles therefore keep applying everywhere,
--    which matches their previous behaviour.
-- ============================================================================
UPDATE MODBUS_ADMIN.roles
   SET scope_level = 'global'
 WHERE scope_level IS NULL;

COMMIT;
