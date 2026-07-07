-- =============================================================================
-- MODBUS_ADMIN schema — run as MODBUS_ADMIN (or a DBA with that schema set)
-- Oracle 12c+ / XE 21c
--
-- Run order:
--   1. Tables (dependency order: projects → locations → brands → devices …)
--   2. Sequences
--   3. View
--   4. Seed data (built-in roles + permissions + initial admin user)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. PROJECTS
-- ---------------------------------------------------------------------------
CREATE TABLE projects (
  id          NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        VARCHAR2(100)  NOT NULL,
  description VARCHAR2(500),
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP,
  updated_at  TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP
);

-- ---------------------------------------------------------------------------
-- 2. LOCATIONS  (self-referencing: a location may have a parent location)
-- ---------------------------------------------------------------------------
CREATE TABLE locations (
  id          NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id  NUMBER         NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,
  parent_id   NUMBER                  REFERENCES locations(id)  ON DELETE SET NULL,
  name        VARCHAR2(100)  NOT NULL,
  description VARCHAR2(500),
  address     VARCHAR2(200),
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP,
  updated_at  TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP
);

-- ---------------------------------------------------------------------------
-- 3. BRANDS
-- ---------------------------------------------------------------------------
CREATE TABLE brands (
  brand_id    NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_name  VARCHAR2(100)  NOT NULL,
  CONSTRAINT uq_brands_name UNIQUE (brand_name)
);

-- ---------------------------------------------------------------------------
-- 4. DEVICES
-- ---------------------------------------------------------------------------
CREATE TABLE devices (
  device_id      NUMBER         PRIMARY KEY,
  device_name    VARCHAR2(100),
  device_ip      VARCHAR2(50),
  device_port    NUMBER         DEFAULT 502,
  status         VARCHAR2(20)   DEFAULT 'offline',
  location_id    NUMBER         REFERENCES locations(id) ON DELETE SET NULL,
  brand_id       NUMBER         REFERENCES brands(brand_id) ON DELETE SET NULL,
  latitude       NUMBER,
  longitude      NUMBER,
  altitude       NUMBER,
  gps_updated_at TIMESTAMP WITH TIME ZONE,
  last_seen      TIMESTAMP WITH TIME ZONE
);

-- ---------------------------------------------------------------------------
-- 5. DEVICE_ACTIONS
-- ---------------------------------------------------------------------------
CREATE TABLE device_actions (
  action_id   NUMBER         PRIMARY KEY,
  device_id   NUMBER         NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  action_type VARCHAR2(50)   NOT NULL,
  action_time TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP
);

CREATE SEQUENCE device_action_seq START WITH 1 INCREMENT BY 1 NOCACHE NOORDER;

-- ---------------------------------------------------------------------------
-- 6. DEVICE_READINGS
-- ---------------------------------------------------------------------------
CREATE TABLE device_readings (
  reading_id   NUMBER         PRIMARY KEY,
  device_id    NUMBER         NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  reading_type VARCHAR2(50)   NOT NULL,
  reading_value NUMBER,
  reading_unit VARCHAR2(20),
  reading_time TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP
);

CREATE SEQUENCE device_reading_seq START WITH 1 INCREMENT BY 1 NOCACHE NOORDER;

-- ---------------------------------------------------------------------------
-- 7. DEVICE_SETTINGS
-- ---------------------------------------------------------------------------
CREATE TABLE device_settings (
  device_id     NUMBER         NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  setting_key   VARCHAR2(100)  NOT NULL,
  setting_value VARCHAR2(500),
  setting_type  VARCHAR2(50),
  CONSTRAINT pk_device_settings PRIMARY KEY (device_id, setting_key)
);

-- ---------------------------------------------------------------------------
-- 8. SYSTEM_SETTINGS
-- ---------------------------------------------------------------------------
CREATE TABLE system_settings (
  setting_key   VARCHAR2(100)  PRIMARY KEY,
  setting_value VARCHAR2(500),
  setting_type  VARCHAR2(50)
);

-- ---------------------------------------------------------------------------
-- 9. USERS
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  user_id       NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      VARCHAR2(60)   NOT NULL,
  email         VARCHAR2(200)  NOT NULL,
  password_hash VARCHAR2(200)  NOT NULL,
  full_name     VARCHAR2(100),
  status        VARCHAR2(20)   DEFAULT 'active'
                CONSTRAINT chk_users_status CHECK (status IN ('active','disabled','locked')),
  failed_logins NUMBER         DEFAULT 0,
  locked_until  TIMESTAMP WITH TIME ZONE,
  last_login_at TIMESTAMP WITH TIME ZONE,
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP,
  updated_at    TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP,
  CONSTRAINT uq_users_username UNIQUE (username),
  CONSTRAINT uq_users_email    UNIQUE (email)
);

-- ---------------------------------------------------------------------------
-- 10. USER_SESSIONS  (refresh tokens — only sha256 hash stored)
-- ---------------------------------------------------------------------------
CREATE TABLE user_sessions (
  session_id         NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id            NUMBER         NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  refresh_token_hash VARCHAR2(64)   NOT NULL,
  user_agent         VARCHAR2(500),
  ip_address         VARCHAR2(64),
  expires_at         TIMESTAMP WITH TIME ZONE NOT NULL,
  revoked_at         TIMESTAMP WITH TIME ZONE,
  last_used_at       TIMESTAMP WITH TIME ZONE,
  created_at         TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP
);

-- ---------------------------------------------------------------------------
-- 11. USER_LOGIN_AUDIT
-- ---------------------------------------------------------------------------
CREATE TABLE user_login_audit (
  audit_id     NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      NUMBER         REFERENCES users(user_id) ON DELETE SET NULL,
  username_try VARCHAR2(60),
  event_type   VARCHAR2(30)   NOT NULL,
  ip_address   VARCHAR2(64),
  user_agent   VARCHAR2(500),
  detail       VARCHAR2(500),
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP
);

-- ---------------------------------------------------------------------------
-- 12. ROLES
-- ---------------------------------------------------------------------------
CREATE TABLE roles (
  role_id          NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role_key         VARCHAR2(60)   NOT NULL,
  role_name        VARCHAR2(100)  NOT NULL,
  description      VARCHAR2(500),
  is_system        NUMBER(1)      DEFAULT 0,
  scope_level      VARCHAR2(20)   DEFAULT 'global',
  scope_project_id NUMBER         REFERENCES projects(id)  ON DELETE SET NULL,
  scope_location_id NUMBER        REFERENCES locations(id) ON DELETE SET NULL,
  scope_device_id  NUMBER         REFERENCES devices(device_id) ON DELETE SET NULL,
  scope_count      NUMBER,
  CONSTRAINT uq_roles_role_key UNIQUE (role_key)
);

-- ---------------------------------------------------------------------------
-- 13. PERMISSIONS
-- ---------------------------------------------------------------------------
CREATE TABLE permissions (
  permission_id  NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  permission_key VARCHAR2(80)   NOT NULL,
  description    VARCHAR2(500),
  resource_type  VARCHAR2(50),
  access_level   VARCHAR2(50),
  CONSTRAINT uq_permissions_key UNIQUE (permission_key)
);

-- ---------------------------------------------------------------------------
-- 14. ROLE_PERMISSIONS
-- ---------------------------------------------------------------------------
CREATE TABLE role_permissions (
  role_id       NUMBER NOT NULL REFERENCES roles(role_id)            ON DELETE CASCADE,
  permission_id NUMBER NOT NULL REFERENCES permissions(permission_id) ON DELETE CASCADE,
  CONSTRAINT pk_role_permissions PRIMARY KEY (role_id, permission_id)
);

-- ---------------------------------------------------------------------------
-- 15. USER_ROLES
-- ---------------------------------------------------------------------------
CREATE TABLE user_roles (
  user_role_id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      NUMBER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role_id      NUMBER NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
  project_id   NUMBER REFERENCES projects(id)               ON DELETE SET NULL,
  location_id  NUMBER REFERENCES locations(id)              ON DELETE SET NULL,
  device_id    NUMBER REFERENCES devices(device_id)         ON DELETE SET NULL,
  granted_by   NUMBER REFERENCES users(user_id)             ON DELETE SET NULL,
  granted_at   TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP
);

-- ---------------------------------------------------------------------------
-- 16. PERMISSION_ENDPOINTS
-- ---------------------------------------------------------------------------
CREATE TABLE permission_endpoints (
  endpoint_id    NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  permission_key VARCHAR2(80)   NOT NULL REFERENCES permissions(permission_key) ON DELETE CASCADE,
  http_method    VARCHAR2(10)   DEFAULT 'ANY',
  path_pattern   VARCHAR2(200)  NOT NULL
);

-- ---------------------------------------------------------------------------
-- 17. PERMISSION_UI_ELEMENTS
-- ---------------------------------------------------------------------------
CREATE TABLE permission_ui_elements (
  element_id     VARCHAR2(60)  NOT NULL,
  permission_key VARCHAR2(80)  NOT NULL REFERENCES permissions(permission_key) ON DELETE CASCADE,
  CONSTRAINT pk_perm_ui_elements PRIMARY KEY (element_id, permission_key)
);

-- ---------------------------------------------------------------------------
-- 18. UI_ELEMENT_CATALOG
-- ---------------------------------------------------------------------------
CREATE TABLE ui_element_catalog (
  element_id VARCHAR2(60)  PRIMARY KEY,
  field      VARCHAR2(40),
  label      VARCHAR2(200),
  sort_order NUMBER DEFAULT 999
);

-- ---------------------------------------------------------------------------
-- 19. UI_FEATURE_PERMISSIONS
-- ---------------------------------------------------------------------------
CREATE TABLE ui_feature_permissions (
  feature_id     VARCHAR2(60)  PRIMARY KEY,
  permission_key VARCHAR2(80)  REFERENCES permissions(permission_key) ON DELETE SET NULL
);

-- ---------------------------------------------------------------------------
-- 20. VIEW: v_project_tree
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_project_tree AS
SELECT
  p.id          AS project_id,
  p.name        AS project_name,
  l.id          AS location_id,
  l.name        AS location_name,
  l.parent_id   AS parent_location_id,
  l.address,
  d.device_id,
  d.device_name,
  d.device_ip,
  d.device_port,
  d.status      AS device_status,
  d.last_seen,
  d.brand_id
FROM projects p
LEFT JOIN locations l ON l.project_id = p.id
LEFT JOIN devices   d ON d.location_id = l.id;

-- =============================================================================
-- SEED DATA
-- =============================================================================

-- ── Built-in permissions ────────────────────────────────────────────────────
INSERT INTO permissions (permission_key, description, resource_type, access_level) VALUES ('device.read',      'View devices',               'device',   'read');
INSERT INTO permissions (permission_key, description, resource_type, access_level) VALUES ('device.write',     'Create/edit devices',        'device',   'write');
INSERT INTO permissions (permission_key, description, resource_type, access_level) VALUES ('device.connect',   'Connect to a device',        'device',   'connect');
INSERT INTO permissions (permission_key, description, resource_type, access_level) VALUES ('device.control',   'Send commands to device',    'device',   'control');
INSERT INTO permissions (permission_key, description, resource_type, access_level) VALUES ('device.start',     'Start a device',             'device',   'start');
INSERT INTO permissions (permission_key, description, resource_type, access_level) VALUES ('device.stop',      'Stop a device',              'device',   'stop');
INSERT INTO permissions (permission_key, description, resource_type, access_level) VALUES ('fuel.read',        'View fuel readings',         'fuel',     'read');
INSERT INTO permissions (permission_key, description, resource_type, access_level) VALUES ('alarm.read',       'View alarms',                'alarm',    'read');
INSERT INTO permissions (permission_key, description, resource_type, access_level) VALUES ('project.read',     'View projects',              'project',  'read');
INSERT INTO permissions (permission_key, description, resource_type, access_level) VALUES ('project.write',    'Create/edit projects',       'project',  'write');
INSERT INTO permissions (permission_key, description, resource_type, access_level) VALUES ('location.read',    'View locations',             'location', 'read');
INSERT INTO permissions (permission_key, description, resource_type, access_level) VALUES ('location.write',   'Create/edit locations',      'location', 'write');
INSERT INTO permissions (permission_key, description, resource_type, access_level) VALUES ('settings.read',    'View settings',              'settings', 'read');
INSERT INTO permissions (permission_key, description, resource_type, access_level) VALUES ('settings.write',   'Edit settings',              'settings', 'write');
INSERT INTO permissions (permission_key, description, resource_type, access_level) VALUES ('user.read',        'View users & roles',         'user',     'read');
INSERT INTO permissions (permission_key, description, resource_type, access_level) VALUES ('user.write',       'Create/edit users',          'user',     'write');
INSERT INTO permissions (permission_key, description, resource_type, access_level) VALUES ('user.assign_role', 'Assign roles & permissions', 'user',     'assign_role');
INSERT INTO permissions (permission_key, description, resource_type, access_level) VALUES ('audit.read',       'View audit log',             'audit',    'read');

-- ── Built-in roles ───────────────────────────────────────────────────────────
INSERT INTO roles (role_key, role_name, description, is_system, scope_level)
  VALUES ('admin', 'Administrator', 'Full system access', 1, 'global');

INSERT INTO roles (role_key, role_name, description, is_system, scope_level)
  VALUES ('viewer', 'Viewer', 'Read-only access', 1, 'global');

INSERT INTO roles (role_key, role_name, description, is_system, scope_level)
  VALUES ('operator', 'Operator', 'Device connect/control access', 1, 'global');

-- Grant all permissions to admin
INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.role_id, p.permission_id
    FROM roles r, permissions p
   WHERE r.role_key = 'admin';

-- Grant read permissions to viewer
INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.role_id, p.permission_id
    FROM roles r
    JOIN permissions p ON p.access_level = 'read'
   WHERE r.role_key = 'viewer';

-- Grant device + fuel + alarm permissions to operator
INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.role_id, p.permission_id
    FROM roles r
    JOIN permissions p ON p.permission_key IN (
      'device.read','device.connect','device.control','device.start','device.stop',
      'fuel.read','alarm.read','project.read','location.read','settings.read'
    )
   WHERE r.role_key = 'operator';

-- ── Initial admin user ────────────────────────────────────────────────────────
-- Default credentials:  admin / Admin@1234
-- CHANGE THE PASSWORD immediately after first login via:
--   POST /api/auth/change-password  { "current": "Admin@1234", "new": "…" }
INSERT INTO users (username, email, password_hash, full_name, status)
  VALUES ('admin', 'admin@localhost',
          '$2b$10$Y8ooQziJ.JdYmyn/S9oDO.AGFmqz.SRKfOueqk6rpqQEgJOtBde96',
          'System Administrator', 'active');

-- Assign admin role to the admin user
INSERT INTO user_roles (user_id, role_id)
  SELECT u.user_id, r.role_id
    FROM users u, roles r
   WHERE u.username = 'admin' AND r.role_key = 'admin';

COMMIT;
