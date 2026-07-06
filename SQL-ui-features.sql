-- ============================================================================
-- SQL-ui-features.sql — admin overrides for UI feature visibility.
--
-- ui_feature_permissions maps a UI feature id (nav link, button, page — see the
-- frontend catalog in config/uiFeatures.js) to the permission that reveals it.
--   • row with a permission_key  → that permission controls the feature
--   • row with NULL permission_key → feature is always visible
--   • no row                       → use the frontend's built-in default
--
-- Safe to re-run. Run as the schema owner:
--   sqlplus modbus_admin/****@localhost:1521/XEPDB1 @SQL-ui-features.sql
-- ============================================================================

DECLARE
  n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM user_tables WHERE table_name = 'UI_FEATURE_PERMISSIONS';
  IF n = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE MODBUS_ADMIN.ui_feature_permissions (
        feature_id     VARCHAR2(60) PRIMARY KEY,
        permission_key VARCHAR2(80),
        updated_at     TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
        CONSTRAINT fk_ufp_permission
          FOREIGN KEY (permission_key)
          REFERENCES MODBUS_ADMIN.permissions(permission_key) ON DELETE CASCADE
      )';
  END IF;
END;
/

COMMENT ON TABLE MODBUS_ADMIN.ui_feature_permissions
  IS 'Admin overrides: which permission reveals each UI feature (nav/button/page)';

COMMIT;
