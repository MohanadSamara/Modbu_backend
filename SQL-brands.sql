-- ============================================================================
-- SQL-brands.sql
--
-- Adds a BRANDS lookup table and links devices to a brand.
--
--   * brands            — one row per brand (e.g. "Cummins", "Perkins").
--   * devices.brand_id  — optional FK to brands. ON DELETE SET NULL so removing
--                         a brand just clears it from its devices (never deletes
--                         a device).
--
-- Run via: node run-brands-migration.js  (idempotent — safe to re-run).
-- ============================================================================

CREATE TABLE MODBUS_ADMIN.brands (
    brand_id   NUMBER(10) GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    brand_name VARCHAR2(100) NOT NULL,
    created_at TIMESTAMP DEFAULT SYSTIMESTAMP,
    CONSTRAINT uq_brands_name UNIQUE (brand_name)
);

ALTER TABLE MODBUS_ADMIN.devices ADD (brand_id NUMBER(10));

ALTER TABLE MODBUS_ADMIN.devices ADD CONSTRAINT fk_devices_brand
    FOREIGN KEY (brand_id) REFERENCES MODBUS_ADMIN.brands (brand_id) ON DELETE SET NULL;

COMMENT ON TABLE  MODBUS_ADMIN.brands            IS 'Device brands/manufacturers.';
COMMENT ON COLUMN MODBUS_ADMIN.devices.brand_id  IS 'Owning brand (FK to brands, nullable, ON DELETE SET NULL).';
