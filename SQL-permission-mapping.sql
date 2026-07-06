-- ============================================================================
-- SQL-permission-mapping.sql — data-driven authorization.
--
-- Adds:
--   • permissions.resource_type / permissions.access_level — the "type" and
--     "access level" of a permission (seeded by splitting the key on '.').
--     (Named *_type / access_level because RESOURCE and ACTION are Oracle
--      keywords and can't be used as bare column names.)
--   • permission_endpoints — maps a permission to the API endpoints it protects.
--     A generic middleware enforces these ON TOP OF the built-in code guards
--     (it can only ADD protection, never remove it).
--
-- Safe to re-run. Run as the schema owner:
--   sqlplus modbus_admin/****@localhost:1521/XEPDB1 @SQL-permission-mapping.sql
-- ============================================================================

-- ── 1. permissions: add resource_type + access_level, guarded ───────────────
DECLARE
  n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM user_tab_columns
   WHERE table_name = 'PERMISSIONS' AND column_name = 'RESOURCE_TYPE';
  IF n = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE MODBUS_ADMIN.permissions ADD (resource_type VARCHAR2(40))';
  END IF;

  SELECT COUNT(*) INTO n FROM user_tab_columns
   WHERE table_name = 'PERMISSIONS' AND column_name = 'ACCESS_LEVEL';
  IF n = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE MODBUS_ADMIN.permissions ADD (access_level VARCHAR2(40))';
  END IF;
END;
/

-- Seed from the key ('device.read' -> resource_type=device, access_level=read).
UPDATE MODBUS_ADMIN.permissions
   SET resource_type = SUBSTR(permission_key, 1, INSTR(permission_key, '.') - 1),
       access_level  = SUBSTR(permission_key, INSTR(permission_key, '.') + 1)
 WHERE INSTR(permission_key, '.') > 0
   AND (resource_type IS NULL OR access_level IS NULL);

COMMENT ON COLUMN MODBUS_ADMIN.permissions.resource_type IS 'type/resource this permission relates to (e.g. device)';
COMMENT ON COLUMN MODBUS_ADMIN.permissions.access_level  IS 'access level of this permission (e.g. read, write)';

-- ── 2. permission_endpoints — permission -> protected API route ─────────────
DECLARE
  n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM user_tables WHERE table_name = 'PERMISSION_ENDPOINTS';
  IF n = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE MODBUS_ADMIN.permission_endpoints (
        endpoint_id    NUMBER(10) GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        permission_key VARCHAR2(80)  NOT NULL,
        http_method    VARCHAR2(10)  DEFAULT ''ANY'' NOT NULL,
        path_pattern   VARCHAR2(255) NOT NULL,
        created_at     TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
        CONSTRAINT fk_pe_permission
          FOREIGN KEY (permission_key)
          REFERENCES MODBUS_ADMIN.permissions(permission_key) ON DELETE CASCADE,
        CONSTRAINT ck_pe_method
          CHECK (http_method IN (''ANY'',''GET'',''POST'',''PUT'',''DELETE'',''PATCH''))
      )';
    EXECUTE IMMEDIATE
      'CREATE INDEX idx_pe_key ON MODBUS_ADMIN.permission_endpoints(permission_key)';
  END IF;
END;
/

COMMIT;

-- ── Verify (optional) ───────────────────────────────────────────────────────
-- SELECT permission_key, resource_type, access_level FROM MODBUS_ADMIN.permissions ORDER BY permission_key;
-- SELECT * FROM MODBUS_ADMIN.permission_endpoints;
