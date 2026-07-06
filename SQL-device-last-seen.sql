-- ============================================================================
-- SQL-device-last-seen.sql
--
-- Ensures MODBUS_ADMIN.devices.LAST_SEEN is a TIMESTAMP column.
--
-- The column originally existed as VARCHAR2(50) DEFAULT 'Never' NOT NULL, which
-- can't hold a real timestamp the frontend can parse. This converts it to a
-- nullable TIMESTAMP. Existing 'Never' placeholder rows become NULL (which the
-- UI already renders as "Never").
--
-- Populated by the backend (see index.js):
--   * /api/modbus/connect              → set to now on a successful connect
--   * PATCH /api/devices/:id/last-seen → set to now on demand
--   * PUT   /api/devices/:id           → optional last_seen ISO-8601 field
--
-- Run via: node run-last-seen-migration.js  (handles the existing-column case)
-- ============================================================================

-- Add a TIMESTAMP column, drop the old VARCHAR2 one, then rename into place.
ALTER TABLE MODBUS_ADMIN.devices ADD (last_seen_ts TIMESTAMP);
ALTER TABLE MODBUS_ADMIN.devices DROP COLUMN last_seen;
ALTER TABLE MODBUS_ADMIN.devices RENAME COLUMN last_seen_ts TO last_seen;

COMMENT ON COLUMN MODBUS_ADMIN.devices.last_seen IS 'Timestamp of the last successful Modbus connection to this device (NULL = never).';
