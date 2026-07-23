-- Datakom cloud→DB sync support (2026-07).
-- These tables are auto-created at startup by db.js (ensureDatakomSyncTables);
-- this file documents the schema for reference / manual application.

-- Idempotency anchor for cloud nodes: which project/location row the sync
-- created for each cloud node. Matching is by map row, never by name, so user
-- renames/moves survive later syncs.
CREATE TABLE MODBUS_ADMIN.datakom_node_map (
  node_key    VARCHAR2(64) NOT NULL,  -- 'node:<cloud node id>' | 'folder:<name>' | 'ungrouped'
  entity_type VARCHAR2(10) NOT NULL CHECK (entity_type IN ('project','location')),
  entity_id   NUMBER NOT NULL,        -- projects.id or locations.id
  created_at  TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_datakom_node_map PRIMARY KEY (node_key, entity_type)
);

-- Idempotency anchor + tombstone for cloud devices: one row per did the sync
-- has ever imported. If the user deletes the DEVICES row, this row remains and
-- the sync never recreates the device.
CREATE TABLE MODBUS_ADMIN.datakom_did_map (
  did        NUMBER PRIMARY KEY,      -- Datakom device id (datakom_did)
  device_id  NUMBER,                  -- DEVICES row created by the sync (informational)
  created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
);

-- Runtime adapter enable override (persisted): system_settings row
--   setting_key = 'DK_ADAPTER_ENABLED', setting_value = '1' | '0'
-- Overrides the DK_ENABLED env default at boot and via the adapter control API.
