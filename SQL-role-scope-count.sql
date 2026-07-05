-- ============================================================================
-- SQL-role-scope-count.sql — add roles.scope_count to an EXISTING database.
--
-- scope_count = how many of the level's entity (projects / locations / devices)
-- a role covers. It's a positive integer (>= 1); global roles leave it at 1.
--
-- Safe to re-run: the ADD COLUMN is guarded so a second run is a no-op.
-- Run as the schema owner:
--   sqlplus modbus_admin/****@localhost:1521/XEPDB1 @SQL-role-scope-count.sql
-- ============================================================================

-- ── 1. Add the column only if it doesn't already exist ──────────────────────
DECLARE
  n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n
    FROM user_tab_columns
   WHERE table_name = 'ROLES' AND column_name = 'SCOPE_COUNT';
  IF n = 0 THEN
    EXECUTE IMMEDIATE
      'ALTER TABLE MODBUS_ADMIN.roles ADD (scope_count NUMBER(10) DEFAULT 1)';
  END IF;
END;
/

-- ── 2. Back-fill any NULLs to 1 ─────────────────────────────────────────────
UPDATE MODBUS_ADMIN.roles SET scope_count = 1 WHERE scope_count IS NULL;

COMMENT ON COLUMN MODBUS_ADMIN.roles.scope_count
  IS 'how many of the level entity this role covers (>=1); 1 for global';

COMMIT;

-- ── Verify (optional) ───────────────────────────────────────────────────────
-- SELECT role_key, scope_level, scope_count FROM MODBUS_ADMIN.roles ORDER BY role_key;
