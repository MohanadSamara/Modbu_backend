-- ============================================================================
-- Authentication + Role-Based Access Control (RBAC) Schema
-- ----------------------------------------------------------------------------
-- Tables:
--   users                  - login accounts (username/email + bcrypt hash)
--   roles                  - role catalog (admin, operator, viewer, ...)
--   permissions            - permission catalog (device.start, fuel.read, ...)
--   role_permissions       - which permissions each role has (M:N)
--   user_roles             - which roles each user has, optionally scoped
--                            to a specific project (M:N + project_id)
--   user_sessions          - server-side refresh-token sessions for login/logout
--   user_login_audit       - audit trail of login/logout/failure events
--
-- Run this script in Oracle SQL*Plus or SQL Developer as a user that can
-- create objects in the MODBUS_ADMIN schema.
-- ============================================================================


-- ============================================================================
-- 1. USERS
-- ============================================================================
CREATE TABLE MODBUS_ADMIN.users (
    user_id        NUMBER(10) GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username       VARCHAR2(60)  NOT NULL,
    email          VARCHAR2(255) NOT NULL,
    password_hash  VARCHAR2(255) NOT NULL,   -- bcrypt/argon2 hash
    full_name      VARCHAR2(120),
    status         VARCHAR2(20)  DEFAULT 'active' NOT NULL,  -- active | disabled | locked
    failed_logins  NUMBER(5)     DEFAULT 0    NOT NULL,
    locked_until   TIMESTAMP,                 -- set when failed_logins exceeds limit
    last_login_at  TIMESTAMP,
    password_changed_at TIMESTAMP DEFAULT SYSTIMESTAMP,
    created_at     TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    updated_at     TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT uq_users_username UNIQUE (username),
    CONSTRAINT uq_users_email    UNIQUE (email),
    CONSTRAINT ck_users_status   CHECK (status IN ('active','disabled','locked'))
);

CREATE INDEX idx_users_status ON MODBUS_ADMIN.users(status);

COMMENT ON TABLE  MODBUS_ADMIN.users IS 'Application user accounts';
COMMENT ON COLUMN MODBUS_ADMIN.users.password_hash IS 'bcrypt or argon2 hash — never store plaintext';
COMMENT ON COLUMN MODBUS_ADMIN.users.failed_logins IS 'Consecutive failed login count (reset on success)';
COMMENT ON COLUMN MODBUS_ADMIN.users.locked_until  IS 'If set and in the future, login is blocked';


-- ============================================================================
-- 2. ROLES
-- ============================================================================
CREATE TABLE MODBUS_ADMIN.roles (
    role_id     NUMBER(10) GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_key    VARCHAR2(40)  NOT NULL,   -- short code: 'admin', 'operator', 'viewer'
    role_name   VARCHAR2(80)  NOT NULL,
    description VARCHAR2(255),
    is_system   NUMBER(1) DEFAULT 0 NOT NULL,  -- 1 = built-in, cannot be deleted
    created_at  TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    updated_at  TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT uq_roles_role_key UNIQUE (role_key),
    CONSTRAINT ck_roles_is_system CHECK (is_system IN (0,1))
);

COMMENT ON TABLE MODBUS_ADMIN.roles IS 'Catalog of roles assigned to users';


-- ============================================================================
-- 3. PERMISSIONS
-- ============================================================================
CREATE TABLE MODBUS_ADMIN.permissions (
    permission_id  NUMBER(10) GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    permission_key VARCHAR2(80)  NOT NULL,   -- e.g. 'device.start', 'fuel.read', 'settings.edit'
    description    VARCHAR2(255),
    created_at     TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT uq_permissions_key UNIQUE (permission_key)
);

COMMENT ON TABLE MODBUS_ADMIN.permissions IS 'Catalog of fine-grained permission strings checked by the API';


-- ============================================================================
-- 4. ROLE → PERMISSIONS (M:N)
-- ============================================================================
CREATE TABLE MODBUS_ADMIN.role_permissions (
    role_id        NUMBER(10) NOT NULL,
    permission_id  NUMBER(10) NOT NULL,
    granted_at     TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_role_permissions PRIMARY KEY (role_id, permission_id),
    CONSTRAINT fk_rp_role
        FOREIGN KEY (role_id)       REFERENCES MODBUS_ADMIN.roles(role_id)             ON DELETE CASCADE,
    CONSTRAINT fk_rp_permission
        FOREIGN KEY (permission_id) REFERENCES MODBUS_ADMIN.permissions(permission_id) ON DELETE CASCADE
);

CREATE INDEX idx_rp_permission ON MODBUS_ADMIN.role_permissions(permission_id);


-- ============================================================================
-- 5. USER → ROLES (M:N) with optional per-project scope
-- ----------------------------------------------------------------------------
-- project_id NULL  = role applies globally (across every project)
-- project_id <set> = role only applies inside that project (per-project scope)
--
-- A user can therefore be e.g. global "viewer" + "operator on project 5".
-- ============================================================================
CREATE TABLE MODBUS_ADMIN.user_roles (
    user_role_id  NUMBER(10) GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       NUMBER(10) NOT NULL,
    role_id       NUMBER(10) NOT NULL,
    project_id    NUMBER(10),                 -- NULL = global; otherwise scoped
    granted_by    NUMBER(10),                 -- user_id of the admin who granted it
    granted_at    TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT fk_ur_user
        FOREIGN KEY (user_id)    REFERENCES MODBUS_ADMIN.users(user_id)    ON DELETE CASCADE,
    CONSTRAINT fk_ur_role
        FOREIGN KEY (role_id)    REFERENCES MODBUS_ADMIN.roles(role_id)    ON DELETE CASCADE,
    CONSTRAINT fk_ur_project
        FOREIGN KEY (project_id) REFERENCES MODBUS_ADMIN.projects(id)      ON DELETE CASCADE,
    CONSTRAINT fk_ur_granted_by
        FOREIGN KEY (granted_by) REFERENCES MODBUS_ADMIN.users(user_id)
);

-- A user shouldn't get the same (role, scope) twice. NULL project_id is treated
-- as a distinct scope using a function-based unique index (Oracle treats NULLs
-- as not-equal, so we coalesce to 0 to make the global scope unique too).
CREATE UNIQUE INDEX uq_user_roles_scope
    ON MODBUS_ADMIN.user_roles (user_id, role_id, NVL(project_id, 0));

CREATE INDEX idx_user_roles_user    ON MODBUS_ADMIN.user_roles(user_id);
CREATE INDEX idx_user_roles_role    ON MODBUS_ADMIN.user_roles(role_id);
CREATE INDEX idx_user_roles_project ON MODBUS_ADMIN.user_roles(project_id);

COMMENT ON COLUMN MODBUS_ADMIN.user_roles.project_id IS 'NULL = global; otherwise role applies only within this project';


-- ============================================================================
-- 6. USER SESSIONS (refresh tokens / "logged-in devices")
-- ----------------------------------------------------------------------------
-- One row per active login. The server stores only a HASH of the refresh
-- token (never the token itself), so a DB leak doesn't grant access.
--
-- Logout      → DELETE the row (or set revoked_at).
-- Force-logout-all → DELETE WHERE user_id = :id.
-- Cleanup     → DELETE WHERE expires_at < SYSTIMESTAMP (run from a cron job).
-- ============================================================================
CREATE TABLE MODBUS_ADMIN.user_sessions (
    session_id        NUMBER(10) GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id           NUMBER(10) NOT NULL,
    refresh_token_hash VARCHAR2(255) NOT NULL,   -- sha256 of the refresh token
    user_agent        VARCHAR2(500),
    ip_address        VARCHAR2(64),
    issued_at         TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    last_used_at      TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    expires_at        TIMESTAMP NOT NULL,
    revoked_at        TIMESTAMP,                 -- set on logout; row may also just be deleted
    CONSTRAINT uq_user_sessions_token UNIQUE (refresh_token_hash),
    CONSTRAINT fk_user_sessions_user
        FOREIGN KEY (user_id) REFERENCES MODBUS_ADMIN.users(user_id) ON DELETE CASCADE
);

CREATE INDEX idx_user_sessions_user    ON MODBUS_ADMIN.user_sessions(user_id);
CREATE INDEX idx_user_sessions_expires ON MODBUS_ADMIN.user_sessions(expires_at);

COMMENT ON TABLE  MODBUS_ADMIN.user_sessions IS 'Server-side login sessions, one row per active refresh token';
COMMENT ON COLUMN MODBUS_ADMIN.user_sessions.refresh_token_hash IS 'SHA-256 hash of the opaque refresh token issued to the client';


-- ============================================================================
-- 7. LOGIN / AUTH AUDIT TRAIL
-- ============================================================================
CREATE TABLE MODBUS_ADMIN.user_login_audit (
    audit_id     NUMBER(10) GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      NUMBER(10),                    -- nullable: failed login may not match a user
    username_try VARCHAR2(60),                  -- raw username attempted (useful on failures)
    event_type   VARCHAR2(40) NOT NULL,         -- LOGIN_OK, LOGIN_FAIL, LOGOUT, PASSWORD_CHANGE, LOCKED, UNLOCKED
    ip_address   VARCHAR2(64),
    user_agent   VARCHAR2(500),
    detail       VARCHAR2(500),
    event_time   TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT fk_audit_user
        FOREIGN KEY (user_id) REFERENCES MODBUS_ADMIN.users(user_id) ON DELETE SET NULL,
    CONSTRAINT ck_audit_event CHECK (event_type IN (
        'LOGIN_OK','LOGIN_FAIL','LOGOUT','PASSWORD_CHANGE','LOCKED','UNLOCKED','REGISTERED'
    ))
);

CREATE INDEX idx_audit_user_time ON MODBUS_ADMIN.user_login_audit(user_id, event_time);
CREATE INDEX idx_audit_event     ON MODBUS_ADMIN.user_login_audit(event_type, event_time);


-- ============================================================================
-- 8. SEED DATA — built-in roles
-- ============================================================================
INSERT INTO MODBUS_ADMIN.roles (role_key, role_name, description, is_system) VALUES
    ('admin',    'Administrator', 'Full access to all features and user management',          1);
INSERT INTO MODBUS_ADMIN.roles (role_key, role_name, description, is_system) VALUES
    ('operator', 'Operator',      'Can connect, start/stop devices, read fuel, manage data', 1);
INSERT INTO MODBUS_ADMIN.roles (role_key, role_name, description, is_system) VALUES
    ('viewer',   'Viewer',        'Read-only access: can view fuel, alarms, and reports',    1);


-- ============================================================================
-- 9. SEED DATA — permissions catalog
-- ----------------------------------------------------------------------------
-- Naming convention: '<resource>.<action>'. Add more as the API grows;
-- the API just checks "does this user have permission key X?".
-- ============================================================================
INSERT INTO MODBUS_ADMIN.permissions (permission_key, description) VALUES ('device.read',     'View devices');
INSERT INTO MODBUS_ADMIN.permissions (permission_key, description) VALUES ('device.write',    'Create/update/delete devices');
INSERT INTO MODBUS_ADMIN.permissions (permission_key, description) VALUES ('device.connect',  'Open/close Modbus connection');
INSERT INTO MODBUS_ADMIN.permissions (permission_key, description) VALUES ('device.control',  'Send START/STOP commands');
INSERT INTO MODBUS_ADMIN.permissions (permission_key, description) VALUES ('fuel.read',       'Read fuel level / consumption');
INSERT INTO MODBUS_ADMIN.permissions (permission_key, description) VALUES ('alarm.read',      'View alarms');
INSERT INTO MODBUS_ADMIN.permissions (permission_key, description) VALUES ('project.read',    'View projects/locations');
INSERT INTO MODBUS_ADMIN.permissions (permission_key, description) VALUES ('project.write',   'Create/update/delete projects/locations');
INSERT INTO MODBUS_ADMIN.permissions (permission_key, description) VALUES ('location.read',   'View locations');
INSERT INTO MODBUS_ADMIN.permissions (permission_key, description) VALUES ('location.write',  'Create/update/delete locations');
INSERT INTO MODBUS_ADMIN.permissions (permission_key, description) VALUES ('settings.read',   'View system/device settings');
INSERT INTO MODBUS_ADMIN.permissions (permission_key, description) VALUES ('settings.write',  'Modify system/device settings');
INSERT INTO MODBUS_ADMIN.permissions (permission_key, description) VALUES ('user.read',       'View users');
INSERT INTO MODBUS_ADMIN.permissions (permission_key, description) VALUES ('user.write',      'Create/update/delete users');
INSERT INTO MODBUS_ADMIN.permissions (permission_key, description) VALUES ('user.assign_role','Grant or revoke roles');
INSERT INTO MODBUS_ADMIN.permissions (permission_key, description) VALUES ('audit.read',      'View login/audit logs');


-- ============================================================================
-- 10. SEED DATA — wire roles to permissions
-- ============================================================================

-- admin → ALL permissions
INSERT INTO MODBUS_ADMIN.role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
  FROM MODBUS_ADMIN.roles r
  CROSS JOIN MODBUS_ADMIN.permissions p
 WHERE r.role_key = 'admin';

-- operator → everything except user/audit management
INSERT INTO MODBUS_ADMIN.role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
  FROM MODBUS_ADMIN.roles r
  JOIN MODBUS_ADMIN.permissions p
    ON p.permission_key IN (
        'device.read','device.write','device.connect','device.control',
        'fuel.read','alarm.read',
        'project.read','project.write',
        'location.read','location.write',
        'settings.read','settings.write'
    )
 WHERE r.role_key = 'operator';

-- viewer → read-only
INSERT INTO MODBUS_ADMIN.role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
  FROM MODBUS_ADMIN.roles r
  JOIN MODBUS_ADMIN.permissions p
    ON p.permission_key IN (
        'device.read','fuel.read','alarm.read','project.read','location.read','settings.read'
    )
 WHERE r.role_key = 'viewer';


-- ============================================================================
-- 11. SEED DATA — bootstrap admin user
-- ----------------------------------------------------------------------------
-- IMPORTANT: replace the placeholder hash below before running in production.
-- The example hash is bcrypt for the password "ChangeMe123!" (cost 10).
-- Generate your own with:
--   node -e "console.log(require('bcrypt').hashSync('YourPassword',10))"
-- ============================================================================
INSERT INTO MODBUS_ADMIN.users (username, email, password_hash, full_name, status)
VALUES (
    'admin',
    'admin@example.com',
    'admin1234',  -- REPLACE
    'System Administrator',
    'active'
);

-- Grant the admin role globally (project_id = NULL)
INSERT INTO MODBUS_ADMIN.user_roles (user_id, role_id, project_id, granted_by)
SELECT u.user_id, r.role_id, NULL, u.user_id
  FROM MODBUS_ADMIN.users u
  JOIN MODBUS_ADMIN.roles r ON r.role_key = 'admin'
 WHERE u.username = 'admin';

COMMIT;


-- ============================================================================
-- 12. CONVENIENCE VIEWS (OPTIONAL — requires CREATE VIEW privilege)
-- ----------------------------------------------------------------------------
-- These two views are sugar — the API works fine without them by inlining
-- the equivalent JOIN. If your account doesn't have CREATE VIEW, skip this
-- whole section. To enable, ask a DBA:
--
--     GRANT CREATE VIEW TO MODBUS_ADMIN;
--
-- Then uncomment the two CREATE VIEW statements below.
--
-- v_user_permissions: flat (user_id, permission_key, project_id) rows.
--   Use it to answer "can user X do action Y on project Z?":
--     SELECT 1 FROM MODBUS_ADMIN.v_user_permissions
--      WHERE user_id = :uid AND permission_key = :perm
--        AND (project_id IS NULL OR project_id = :pid);
--   project_id NULL  → permission granted globally
--
-- Inline equivalent (use this in Node if you skip the views):
--   SELECT 1
--     FROM MODBUS_ADMIN.user_roles       ur
--     JOIN MODBUS_ADMIN.role_permissions rp ON rp.role_id      = ur.role_id
--     JOIN MODBUS_ADMIN.permissions      p  ON p.permission_id = rp.permission_id
--     JOIN MODBUS_ADMIN.users            u  ON u.user_id       = ur.user_id
--    WHERE u.status        = 'active'
--      AND ur.user_id      = :uid
--      AND p.permission_key = :perm
--      AND (ur.project_id IS NULL OR ur.project_id = :pid)
--      AND ROWNUM = 1;
-- ============================================================================
-- CREATE OR REPLACE VIEW MODBUS_ADMIN.v_user_permissions AS
-- SELECT ur.user_id,
--        p.permission_key,
--        ur.project_id,
--        r.role_key
--   FROM MODBUS_ADMIN.user_roles       ur
--   JOIN MODBUS_ADMIN.roles            r  ON r.role_id        = ur.role_id
--   JOIN MODBUS_ADMIN.role_permissions rp ON rp.role_id       = ur.role_id
--   JOIN MODBUS_ADMIN.permissions      p  ON p.permission_id  = rp.permission_id
--   JOIN MODBUS_ADMIN.users            u  ON u.user_id        = ur.user_id
--  WHERE u.status = 'active';

-- v_active_sessions: admin "currently logged-in users" panel.
-- Inline equivalent:
--   SELECT s.session_id, s.user_id, u.username, s.user_agent, s.ip_address,
--          s.issued_at, s.last_used_at, s.expires_at
--     FROM MODBUS_ADMIN.user_sessions s
--     JOIN MODBUS_ADMIN.users         u ON u.user_id = s.user_id
--    WHERE s.revoked_at IS NULL AND s.expires_at > SYSTIMESTAMP;
-- CREATE OR REPLACE VIEW MODBUS_ADMIN.v_active_sessions AS
-- SELECT s.session_id,
--        s.user_id,
--        u.username,
--        s.user_agent,
--        s.ip_address,
--        s.issued_at,
--        s.last_used_at,
--        s.expires_at
--   FROM MODBUS_ADMIN.user_sessions s
--   JOIN MODBUS_ADMIN.users         u ON u.user_id = s.user_id
--  WHERE s.revoked_at IS NULL
--    AND s.expires_at  > SYSTIMESTAMP;


-- ============================================================================
-- 13. (Optional) GRANTS for the application user
-- ----------------------------------------------------------------------------
-- Uncomment and replace YOUR_APP_USER with the schema/user the Node app
-- connects as (the one in your .env ORACLE_USER). The app needs DML on
-- everything except permissions catalog (read-only is fine there).
-- ============================================================================
-- GRANT SELECT, INSERT, UPDATE, DELETE ON MODBUS_ADMIN.users              TO YOUR_APP_USER;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON MODBUS_ADMIN.user_roles         TO YOUR_APP_USER;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON MODBUS_ADMIN.user_sessions      TO YOUR_APP_USER;
-- GRANT SELECT, INSERT                  ON MODBUS_ADMIN.user_login_audit  TO YOUR_APP_USER;
-- GRANT SELECT                          ON MODBUS_ADMIN.roles             TO YOUR_APP_USER;
-- GRANT SELECT                          ON MODBUS_ADMIN.permissions       TO YOUR_APP_USER;
-- GRANT SELECT                          ON MODBUS_ADMIN.role_permissions  TO YOUR_APP_USER;
-- GRANT SELECT                          ON MODBUS_ADMIN.v_user_permissions TO YOUR_APP_USER;
-- GRANT SELECT                          ON MODBUS_ADMIN.v_active_sessions TO YOUR_APP_USER;
