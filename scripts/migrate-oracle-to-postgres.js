// One-time data migration: copies every row from the existing Oracle XE
// database into the new Postgres schema (see migrations/postgres/001_init.sql,
// which must already have been applied to the target DATABASE_URL).
//
// Tables are copied in FK-safe order. Identity-column PKs are inserted
// explicitly (not left to the generator) so foreign keys between migrated rows
// stay intact; afterwards each identity sequence is advanced past the highest
// migrated id so the app's own inserts don't collide with migrated rows.
//
// Usage:
//   ORACLE_USER=... ORACLE_PASSWORD=... ORACLE_HOST=... ORACLE_PORT=... ORACLE_SERVICE_NAME=... \
//   DATABASE_URL=postgres://... node scripts/migrate-oracle-to-postgres.js
//
// Oracle env vars default to the values already used by the pre-migration
// .env (kept out of the app's own config since the app no longer speaks
// Oracle) — pass them explicitly if they differ.
const oracledb = require('oracledb');
const { Pool } = require('pg');
require('dotenv').config();

// page_content.content_json is a CLOB — without this, oracledb hands back a
// Lob stream object instead of a plain string and the pg insert blows up.
oracledb.fetchAsString = [oracledb.CLOB];

const ORACLE_CONFIG = {
  user: process.env.ORACLE_USER || 'MODBUS_ADMIN',
  password: process.env.ORACLE_PASSWORD,
  connectString: `${process.env.ORACLE_HOST || 'localhost'}:${process.env.ORACLE_PORT || 1521}/${process.env.ORACLE_SERVICE_NAME || 'XEPDB1'}`,
};

// { oracleTable, pgTable, columns: [{ora, pg}], identityColumn? }
// `columns` lists every column to copy, in the order the INSERT will use.
// `identityColumn` (pg name) gets its sequence advanced after the copy —
// omitted for tables with a manually-assigned PK (devices).
const TABLES = [
  { oracle: 'USERS', pg: 'users', identityColumn: 'user_id', columns: [
    'USER_ID', 'USERNAME', 'EMAIL', 'PASSWORD_HASH', 'FULL_NAME', 'STATUS',
    'FAILED_LOGINS', 'LOCKED_UNTIL', 'LAST_LOGIN_AT', 'PASSWORD_CHANGED_AT', 'CREATED_AT', 'UPDATED_AT',
  ]},
  { oracle: 'ROLES', pg: 'roles', identityColumn: 'role_id', columns: [
    'ROLE_ID', 'ROLE_KEY', 'ROLE_NAME', 'DESCRIPTION', 'IS_SYSTEM', 'CREATED_AT', 'UPDATED_AT',
    'SCOPE_LEVEL', 'SCOPE_PROJECT_ID', 'SCOPE_LOCATION_ID', 'SCOPE_DEVICE_ID', 'SCOPE_COUNT',
  ]},
  { oracle: 'PERMISSIONS', pg: 'permissions', identityColumn: 'permission_id', columns: [
    'PERMISSION_ID', 'PERMISSION_KEY', 'DESCRIPTION', 'CREATED_AT', 'RESOURCE_TYPE', 'ACCESS_LEVEL',
  ]},
  { oracle: 'BRANDS', pg: 'brands', identityColumn: 'brand_id', columns: [
    'BRAND_ID', 'BRAND_NAME', 'CREATED_AT',
  ]},
  // parent_id is self-referencing and Oracle doesn't return rows in parent-
  // before-child order, so it's nulled on insert and backfilled in a second
  // pass (see selfRefColumn below) rather than risk an FK violation.
  { oracle: 'PROJECTS', pg: 'projects', identityColumn: 'id', selfRefColumn: 'PARENT_ID', columns: [
    'ID', 'NAME', 'DESCRIPTION', 'CREATED_AT', 'UPDATED_AT', 'BRAND_ID', 'METHOD', 'PARENT_ID',
  ]},
  { oracle: 'LOCATIONS', pg: 'locations', identityColumn: 'id', selfRefColumn: 'PARENT_ID', columns: [
    'ID', 'PROJECT_ID', 'NAME', 'DESCRIPTION', 'ADDRESS', 'CREATED_AT', 'UPDATED_AT', 'PARENT_ID',
  ]},
  // devices.device_id is manually assigned in the app — no identity sequence to advance.
  { oracle: 'DEVICES', pg: 'devices', columns: [
    'DEVICE_ID', 'DEVICE_NAME', 'DEVICE_IP', 'DEVICE_PORT', 'STATUS', 'LOCATION_ID',
    'LATITUDE', 'LONGITUDE', 'ALTITUDE', 'GPS_UPDATED_AT', 'LAST_SEEN', 'BRAND_ID', 'DATAKOM_DID',
  ]},
  { oracle: 'ROLE_PERMISSIONS', pg: 'role_permissions', columns: [
    'ROLE_ID', 'PERMISSION_ID', 'GRANTED_AT',
  ]},
  { oracle: 'USER_ROLES', pg: 'user_roles', identityColumn: 'user_role_id', columns: [
    'USER_ROLE_ID', 'USER_ID', 'ROLE_ID', 'PROJECT_ID', 'GRANTED_BY', 'GRANTED_AT', 'LOCATION_ID', 'DEVICE_ID',
  ]},
  { oracle: 'DEVICE_ACTIONS', pg: 'device_actions', identityColumn: 'action_id', columns: [
    'ACTION_ID', 'DEVICE_ID', 'ACTION_TYPE', 'ACTION_TIME',
  ]},
  { oracle: 'DEVICE_READINGS', pg: 'device_readings', identityColumn: 'reading_id', columns: [
    'READING_ID', 'DEVICE_ID', 'READING_TYPE', 'READING_VALUE', 'READING_UNIT', 'READING_TIME',
  ]},
  { oracle: 'DEVICE_SETTINGS', pg: 'device_settings', identityColumn: 'setting_id', columns: [
    'SETTING_ID', 'DEVICE_ID', 'SETTING_KEY', 'SETTING_VALUE', 'SETTING_TYPE', 'CREATED_AT', 'UPDATED_AT',
  ]},
  { oracle: 'DEVICE_SNOOZES', pg: 'device_snoozes', columns: [
    'DEVICE_ID', 'SNOOZE_UNTIL', 'UPDATED_BY', 'UPDATED_AT',
  ]},
  { oracle: 'ALARMS', pg: 'alarms', identityColumn: 'alarm_id', columns: [
    'ALARM_ID', 'DEVICE_ID', 'ALARM_TYPE', 'SEVERITY', 'MESSAGE', 'FUEL_VALUE', 'THRESHOLD_VALUE',
    'TRIGGERED_AT', 'ACKNOWLEDGED', 'ACKNOWLEDGED_BY', 'ACKNOWLEDGED_AT',
  ]},
  { oracle: 'ALARM_ACKNOWLEDGMENTS', pg: 'alarm_acknowledgments', identityColumn: 'ack_id', columns: [
    'ACK_ID', 'ACTION_ID', 'DEVICE_ID', 'ACKNOWLEDGED_BY', 'ACKNOWLEDGED_AT',
  ]},
  { oracle: 'DATAKOM_DID_MAP', pg: 'datakom_did_map', columns: [
    'DID', 'DEVICE_ID', 'CREATED_AT',
  ]},
  { oracle: 'DATAKOM_NODE_MAP', pg: 'datakom_node_map', columns: [
    'NODE_KEY', 'ENTITY_TYPE', 'ENTITY_ID', 'CREATED_AT',
  ]},
  { oracle: 'DATAKOM_NODE_NAMES', pg: 'datakom_node_names', columns: [
    'NODE_ID', 'CUSTOM_NAME', 'UPDATED_BY', 'UPDATED_AT',
  ]},
  { oracle: 'DATAKOM_NODE_CONTAINERS', pg: 'datakom_node_containers', columns: [
    'NODE_ID', 'CONTAINER_NAME', 'UPDATED_BY', 'UPDATED_AT',
  ]},
  { oracle: 'PAGE_CONTENT', pg: 'page_content', columns: [
    'CONTENT_KEY', 'CONTENT_JSON', 'UPDATED_BY', 'UPDATED_AT',
  ]},
  { oracle: 'PERMISSION_ENDPOINTS', pg: 'permission_endpoints', identityColumn: 'endpoint_id', columns: [
    'ENDPOINT_ID', 'PERMISSION_KEY', 'HTTP_METHOD', 'PATH_PATTERN', 'CREATED_AT',
  ]},
  { oracle: 'PERMISSION_UI_ELEMENTS', pg: 'permission_ui_elements', identityColumn: 'mapping_id', columns: [
    'MAPPING_ID', 'PERMISSION_KEY', 'ELEMENT_ID', 'CREATED_AT',
  ]},
  { oracle: 'SYSTEM_SETTINGS', pg: 'system_settings', identityColumn: 'setting_id', columns: [
    'SETTING_ID', 'SETTING_KEY', 'SETTING_VALUE', 'SETTING_TYPE', 'DESCRIPTION', 'CREATED_AT', 'UPDATED_AT',
  ]},
  { oracle: 'UI_ELEMENT_CATALOG', pg: 'ui_element_catalog', columns: [
    'ELEMENT_ID', 'FIELD', 'LABEL', 'SORT_ORDER',
  ]},
  { oracle: 'UI_FEATURE_PERMISSIONS', pg: 'ui_feature_permissions', columns: [
    'FEATURE_ID', 'PERMISSION_KEY',
  ]},
  { oracle: 'USER_LOGIN_AUDIT', pg: 'user_login_audit', identityColumn: 'audit_id', columns: [
    'AUDIT_ID', 'USER_ID', 'USERNAME_TRY', 'EVENT_TYPE', 'IP_ADDRESS', 'USER_AGENT', 'DETAIL', 'EVENT_TIME',
  ]},
  { oracle: 'USER_SESSIONS', pg: 'user_sessions', identityColumn: 'session_id', columns: [
    'SESSION_ID', 'USER_ID', 'REFRESH_TOKEN_HASH', 'USER_AGENT', 'IP_ADDRESS',
    'ISSUED_AT', 'LAST_USED_AT', 'EXPIRES_AT', 'REVOKED_AT',
  ]},
];

async function migrateTable(oracleConn, pgPool, spec) {
  const selectCols = spec.columns.join(', ');
  const result = await oracleConn.execute(
    `SELECT ${selectCols} FROM ${spec.oracle}`,
    [],
    { outFormat: oracledb.OUT_FORMAT_OBJECT }
  );
  const rows = result.rows || [];
  if (rows.length === 0) {
    console.log(`[migrate] ${spec.pg}: 0 rows`);
    return 0;
  }

  const pgCols = spec.columns.map((c) => c.toLowerCase());
  const placeholders = pgCols.map((_, i) => `$${i + 1}`).join(', ');
  const insertSql = `INSERT INTO ${spec.pg} (${pgCols.join(', ')}) VALUES (${placeholders})`;
  const selfRefIndex = spec.selfRefColumn ? spec.columns.indexOf(spec.selfRefColumn) : -1;
  const pkColumn = spec.identityColumn || spec.columns[0].toLowerCase();
  const selfRefPgCol = selfRefIndex >= 0 ? pgCols[selfRefIndex] : null;

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      const values = spec.columns.map((c, i) =>
        i === selfRefIndex ? null : (row[c] ?? null)
      );
      await client.query(insertSql, values);
    }
    if (selfRefIndex >= 0) {
      for (const row of rows) {
        const parentValue = row[spec.selfRefColumn];
        if (parentValue == null) continue;
        await client.query(
          `UPDATE ${spec.pg} SET ${selfRefPgCol} = $1 WHERE ${pkColumn} = $2`,
          [parentValue, row[spec.columns[0]]]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log(`[migrate] ${spec.pg}: ${rows.length} row(s)`);
  return rows.length;
}

async function fixSequence(pgPool, spec) {
  if (!spec.identityColumn) return;
  await pgPool.query(
    `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${spec.identityColumn}) FROM ${spec.pg}), 1), true)`,
    [spec.pg, spec.identityColumn]
  );
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — point it at the target Postgres database.');
    process.exit(1);
  }

  const oracleConn = await oracledb.getConnection(ORACLE_CONFIG);
  const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  });

  let totalRows = 0;
  try {
    for (const spec of TABLES) {
      totalRows += await migrateTable(oracleConn, pgPool, spec);
    }
    console.log(`[migrate] Copied ${totalRows} row(s) across ${TABLES.length} table(s). Advancing sequences...`);
    for (const spec of TABLES) {
      await fixSequence(pgPool, spec);
    }
    console.log('[migrate] Done.');
  } finally {
    await oracleConn.close();
    await pgPool.end();
  }
}

main().catch((err) => {
  console.error('[migrate] Failed:', err);
  process.exit(1);
});
