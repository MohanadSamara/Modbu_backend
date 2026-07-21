-- ============================================================================
-- Add a brand + connection method to projects.
--
-- A project now carries:
--   BRAND_ID  NUMBER      nullable FK -> brands(brand_id) (ON DELETE SET NULL)
--   METHOD    VARCHAR2    'cloud' (Datakom Rainbow) | 'ip' (Modbus TCP)
--
-- METHOD drives the DEFAULT connection type of devices created under the
-- project. A "Datakom" brand starts a project in 'cloud' method; every other
-- brand starts in 'ip'. Editing a device under a cloud project to add an IP
-- flips THAT device to Modbus/IP (per-device; the project method is unchanged).
--
-- Run once against the MODBUS_ADMIN schema. Idempotent-ish: re-running the ADDs
-- errors with ORA-01430 (column already exists) — safe to ignore on re-run.
-- ============================================================================

ALTER TABLE MODBUS_ADMIN.projects ADD (
  brand_id NUMBER,
  method   VARCHAR2(10) DEFAULT 'ip'
);

ALTER TABLE MODBUS_ADMIN.projects
  ADD CONSTRAINT fk_projects_brand
  FOREIGN KEY (brand_id) REFERENCES MODBUS_ADMIN.brands (brand_id)
  ON DELETE SET NULL;

-- Constrain METHOD to the two known values (NULL allowed for legacy rows; the
-- API always writes 'cloud' or 'ip' on create).
ALTER TABLE MODBUS_ADMIN.projects
  ADD CONSTRAINT ck_projects_method
  CHECK (method IN ('cloud', 'ip'));

-- Backfill existing rows: default everything to 'ip' (Modbus). Adjust by hand
-- afterwards if any existing project should be a Datakom/cloud project.
UPDATE MODBUS_ADMIN.projects SET method = 'ip' WHERE method IS NULL;

COMMIT;
