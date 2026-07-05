-- ============================================================================
-- SQL-permission-elements.sql — which UI elements a permission grants.
--
-- permission_ui_elements maps a permission to the granular UI elements (buttons
-- and controls — see the frontend catalog in config/uiElements.js) it covers.
-- It is a MANY-TO-MANY join: one permission may cover many elements, and the
-- SAME element may be listed under several permissions (e.g. alarm.read and
-- alarm.write both reference alarm.mute — read reveals it, write lets you use
-- it). Whether a covered element is usable vs view-only is decided by the
-- permission's OWN access level (read = view only, anything else = usable).
--
--   • row (permission_key, element_id) → that permission covers that element
--   • no row                           → the permission does not cover it
--
-- Safe to re-run. Run as the schema owner:
--   sqlplus modbus_admin/****@localhost:1521/XEPDB1 @SQL-permission-elements.sql
-- ============================================================================

DECLARE
  n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM user_tables WHERE table_name = 'PERMISSION_UI_ELEMENTS';
  IF n = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE MODBUS_ADMIN.permission_ui_elements (
        mapping_id     NUMBER(10) GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        permission_key VARCHAR2(80) NOT NULL,
        element_id     VARCHAR2(60) NOT NULL,
        created_at     TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
        CONSTRAINT fk_pue_permission
          FOREIGN KEY (permission_key)
          REFERENCES MODBUS_ADMIN.permissions(permission_key) ON DELETE CASCADE,
        CONSTRAINT uq_pue_perm_element
          UNIQUE (permission_key, element_id)
      )';
    EXECUTE IMMEDIATE
      'CREATE INDEX idx_pue_key ON MODBUS_ADMIN.permission_ui_elements(permission_key)';
    EXECUTE IMMEDIATE
      'CREATE INDEX idx_pue_element ON MODBUS_ADMIN.permission_ui_elements(element_id)';
  END IF;
END;
/

COMMENT ON TABLE MODBUS_ADMIN.permission_ui_elements
  IS 'Which granular UI elements (buttons/controls) each permission covers';

COMMIT;

-- ── Verify (optional) ───────────────────────────────────────────────────────
-- SELECT permission_key, element_id FROM MODBUS_ADMIN.permission_ui_elements ORDER BY permission_key, element_id;
