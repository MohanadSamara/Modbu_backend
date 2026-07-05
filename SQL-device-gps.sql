-- ============================================================================
-- SQL-device-gps.sql
--
-- Adds GPS position columns to the devices table so every device can be shown
-- on the Dashboard map.
--
-- Coordinates are populated two ways (see modbus_connect.readGps + index.js):
--   1. Live from the device over Modbus — registers 10594 (latitude),
--      10596 (longitude), 10598 (altitude), each a 32-bit value. Read whenever
--      the device is connected and written back here.
--   2. Manually, via the Add/Edit device form (works for offline devices too).
--
-- latitude/longitude are stored as decimal degrees (WGS-84), e.g. 31.9539.
-- ============================================================================

ALTER TABLE MODBUS_ADMIN.devices ADD (
    latitude       NUMBER(10,7),          -- decimal degrees, -90 .. 90
    longitude      NUMBER(10,7),          -- decimal degrees, -180 .. 180
    altitude       NUMBER(10,2),          -- metres above sea level
    gps_updated_at TIMESTAMP              -- when coordinates were last set/read
);

COMMENT ON COLUMN MODBUS_ADMIN.devices.latitude       IS 'Device latitude in decimal degrees (WGS-84). From Modbus reg 10594 or manual entry.';
COMMENT ON COLUMN MODBUS_ADMIN.devices.longitude      IS 'Device longitude in decimal degrees (WGS-84). From Modbus reg 10596 or manual entry.';
COMMENT ON COLUMN MODBUS_ADMIN.devices.altitude       IS 'Device altitude in metres. From Modbus reg 10598.';
COMMENT ON COLUMN MODBUS_ADMIN.devices.gps_updated_at IS 'Timestamp coordinates were last updated (live read or manual save).';
