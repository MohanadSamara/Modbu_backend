-- ============================================================================
-- Device Settings Table SQL Script
-- Run this script in Oracle SQL*Plus or SQL Developer
-- ============================================================================

-- Create device_settings table for storing device-specific settings
CREATE TABLE MODBUS_ADMIN.device_settings (
    setting_id NUMBER(10) GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id NUMBER(10) NOT NULL,
    setting_key VARCHAR2(100) NOT NULL,
    setting_value VARCHAR2(500),
    setting_type VARCHAR2(20) DEFAULT 'string',
    created_at TIMESTAMP DEFAULT SYSTIMESTAMP,
    updated_at TIMESTAMP DEFAULT SYSTIMESTAMP,
    CONSTRAINT fk_device_settings_device FOREIGN KEY (device_id) 
        REFERENCES MODBUS_ADMIN.devices(device_id) ON DELETE CASCADE,
    CONSTRAINT uq_device_settings_key UNIQUE (device_id, setting_key)
);

-- Create index for faster queries
CREATE INDEX idx_device_settings_device ON MODBUS_ADMIN.device_settings(device_id);
CREATE INDEX idx_device_settings_key ON MODBUS_ADMIN.device_settings(setting_key);

-- Comment on the table
COMMENT ON TABLE MODBUS_ADMIN.device_settings IS 'Device-specific settings (alarms, thresholds, etc.)';
COMMENT ON COLUMN MODBUS_ADMIN.device_settings.setting_id IS 'Primary key';
COMMENT ON COLUMN MODBUS_ADMIN.device_settings.device_id IS 'Foreign key to devices table';
COMMENT ON COLUMN MODBUS_ADMIN.device_settings.setting_key IS 'Setting key (e.g., LOW_TANK_THRESHOLD, CONSUMPTION_RATE)';
COMMENT ON COLUMN MODBUS_ADMIN.device_settings.setting_value IS 'Setting value as string';
COMMENT ON COLUMN MODBUS_ADMIN.device_settings.setting_type IS 'Data type: number, boolean, string';

-- ============================================================================
-- Insert default settings for existing devices
-- ============================================================================

-- Example: Add default fuel alarm settings for device_id = 1
-- INSERT INTO MODBUS_ADMIN.device_settings (device_id, setting_key, setting_value, setting_type)
-- VALUES (1, 'LOW_TANK_THRESHOLD', '20', 'number');

-- INSERT INTO MODBUS_ADMIN.device_settings (device_id, setting_key, setting_value, setting_type)
-- VALUES (1, 'CRITICAL_TANK_THRESHOLD', '10', 'number');

-- INSERT INTO MODBUS_ADMIN.device_settings (device_id, setting_key, setting_value, setting_type)
-- VALUES (1, 'CONSUMPTION_RATE_THRESHOLD', '5', 'number');

-- INSERT INTO MODBUS_ADMIN.device_settings (device_id, setting_key, setting_value, setting_type)
-- VALUES (1, 'FUEL_ALERTS_ENABLED', 'true', 'boolean');

-- ============================================================================
-- Global/System Settings Table (optional - for app-wide settings)
-- ============================================================================

CREATE TABLE MODBUS_ADMIN.system_settings (
    setting_id NUMBER(10) GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    setting_key VARCHAR2(100) NOT NULL UNIQUE,
    setting_value VARCHAR2(500),
    setting_type VARCHAR2(20) DEFAULT 'string',
    description VARCHAR2(500),
    created_at TIMESTAMP DEFAULT SYSTIMESTAMP,
    updated_at TIMESTAMP DEFAULT SYSTIMESTAMP
);

COMMENT ON TABLE MODBUS_ADMIN.system_settings IS 'Global/system-wide settings';

-- Insert default system settings
INSERT INTO MODBUS_ADMIN.system_settings (setting_key, setting_value, setting_type, description) 
VALUES ('DEFAULT_PORT', '502', 'number', 'Default Modbus port');

INSERT INTO MODBUS_ADMIN.system_settings (setting_key, setting_value, setting_type, description) 
VALUES ('CONNECTION_TIMEOUT', '5000', 'number', 'Connection timeout in milliseconds');

INSERT INTO MODBUS_ADMIN.system_settings (setting_key, setting_value, setting_type, description) 
VALUES ('RETRY_ATTEMPTS', '3', 'number', 'Number of connection retry attempts');

INSERT INTO MODBUS_ADMIN.system_settings (setting_key, setting_value, setting_type, description) 
VALUES ('AUTO_RECONNECT', 'false', 'boolean', 'Enable auto-reconnect on disconnect');

INSERT INTO MODBUS_ADMIN.system_settings (setting_key, setting_value, setting_type, description) 
VALUES ('SHOW_OFFLINE_DEVICES', 'true', 'boolean', 'Show offline devices in list');

INSERT INTO MODBUS_ADMIN.system_settings (setting_key, setting_value, setting_type, description) 
VALUES ('DEFAULT_PROJECT_VIEW', 'expanded', 'string', 'Default project view mode: compact or expanded');

COMMIT;

-- ============================================================================
-- Grant permissions (adjust as needed)
-- ============================================================================

-- GRANT SELECT ON MODBUS_ADMIN.device_settings TO your_app_user;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON MODBUS_ADMIN.device_settings TO your_app_user;
-- GRANT SELECT ON MODBUS_ADMIN.system_settings TO your_app_user;
-- GRANT SELECT, UPDATE ON MODBUS_ADMIN.system_settings TO your_app_user;
