-- ============================================================================
-- SQL-ui-element-catalog.sql — the master catalog of granular UI elements.
--
-- ui_element_catalog holds every UI element (button/control) an admin can point
-- a permission at, grouped by FIELD (resource). It replaces the hard-coded list
-- that used to live in the frontend (config/uiElements.js): the frontend now
-- fetches this table via GET /api/ui-element-catalog.
--
--   element_id  stable key checked at runtime via <Can element="…">
--   field       the resource/field it belongs to (used to group in the editor)
--   label       human name shown in the editor
--   sort_order  display order
--
-- Safe to re-run (create is guarded; seed uses MERGE). Run as the schema owner:
--   sqlplus modbus_admin/****@localhost:1521/XEPDB1 @SQL-ui-element-catalog.sql
-- ============================================================================

DECLARE
  n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM user_tables WHERE table_name = 'UI_ELEMENT_CATALOG';
  IF n = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE MODBUS_ADMIN.ui_element_catalog (
        element_id VARCHAR2(60)  PRIMARY KEY,
        field      VARCHAR2(40)  NOT NULL,
        label      VARCHAR2(200) NOT NULL,
        sort_order NUMBER(6)     DEFAULT 0 NOT NULL
      )';
  END IF;
END;
/

COMMENT ON TABLE MODBUS_ADMIN.ui_element_catalog
  IS 'Master catalog of granular UI elements (buttons/controls), grouped by field';

-- ── Seed / refresh the built-in catalog ─────────────────────────────────────
MERGE INTO MODBUS_ADMIN.ui_element_catalog t
USING (
  -- Alarm
  SELECT 'alarm.mute'         AS element_id, 'alarm'    AS field, 'Mute alarm sound button'      AS label, 10 AS sort_order FROM dual UNION ALL
  SELECT 'alarm.acknowledge', 'alarm',    'Acknowledge alarm',            11 FROM dual UNION ALL
  SELECT 'alarm.reset',       'alarm',    'Reset / clear active alarm',   12 FROM dual UNION ALL
  SELECT 'alarm.view_events', 'alarm',    'View events / alarms log',     13 FROM dual UNION ALL
  -- Device
  SELECT 'device.connect',    'device',   'Connect / Disconnect button',  20 FROM dual UNION ALL
  SELECT 'device.start_stop', 'device',   'Start / Stop controls',        21 FROM dual UNION ALL
  SELECT 'device.add',        'device',   'Add device button',            22 FROM dual UNION ALL
  SELECT 'device.edit',       'device',   'Edit device configuration',    23 FROM dual UNION ALL
  SELECT 'device.delete',     'device',   'Delete device button',         24 FROM dual UNION ALL
  -- Project
  SELECT 'project.create',    'project',  'Create project / location',    30 FROM dual UNION ALL
  SELECT 'project.rename',    'project',  'Rename project / location',    31 FROM dual UNION ALL
  SELECT 'project.delete',    'project',  'Delete project / location',    32 FROM dual UNION ALL
  -- Settings
  SELECT 'settings.edit',     'settings', 'Edit settings button',         40 FROM dual UNION ALL
  SELECT 'settings.reset',    'settings', 'Reset settings to default',    41 FROM dual UNION ALL
  -- User administration
  SELECT 'user.create',        'user',    'Create user button',           50 FROM dual UNION ALL
  SELECT 'user.edit',          'user',    'Edit user details',            51 FROM dual UNION ALL
  SELECT 'user.lock',          'user',    'Lock / unlock user',           52 FROM dual UNION ALL
  SELECT 'user.reset_password','user',    'Reset user password',          53 FROM dual UNION ALL
  SELECT 'user.assign_role',   'user',    'Assign role button',           54 FROM dual UNION ALL
  SELECT 'user.delete',        'user',    'Delete user',                  55 FROM dual UNION ALL
  -- Audit
  SELECT 'audit.view',        'audit',    'View audit log',               60 FROM dual UNION ALL
  SELECT 'audit.export',      'audit',    'Export audit log',             61 FROM dual
) s
ON (t.element_id = s.element_id)
WHEN MATCHED THEN
  UPDATE SET t.field = s.field, t.label = s.label, t.sort_order = s.sort_order
WHEN NOT MATCHED THEN
  INSERT (element_id, field, label, sort_order)
  VALUES (s.element_id, s.field, s.label, s.sort_order);

COMMIT;

-- ── Verify (optional) ───────────────────────────────────────────────────────
-- SELECT field, element_id, label FROM MODBUS_ADMIN.ui_element_catalog ORDER BY sort_order;
