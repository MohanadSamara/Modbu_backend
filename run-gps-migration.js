// One-off runner for SQL-device-gps.sql — adds the GPS columns to devices.
// Safe to run more than once: "column already exists" (ORA-01430) is ignored.
// Usage:  node run-gps-migration.js
const { getConnection } = require('./db');

const STATEMENTS = [
  `ALTER TABLE MODBUS_ADMIN.devices ADD (
     latitude       NUMBER(10,7),
     longitude      NUMBER(10,7),
     altitude       NUMBER(10,2),
     gps_updated_at TIMESTAMP
   )`,
];

(async () => {
  const conn = await getConnection();
  if (!conn) { console.error('DB unavailable — check .env / Oracle is up'); process.exit(1); }
  try {
    for (const sql of STATEMENTS) {
      try {
        await conn.execute(sql, [], { autoCommit: true });
        console.log('✓ Columns added to MODBUS_ADMIN.devices');
      } catch (e) {
        if (/ORA-01430/i.test(e.message)) {
          console.log('• Columns already exist — nothing to do');
        } else {
          throw e;
        }
      }
    }
    // Verify
    const r = await conn.execute(
      `SELECT column_name FROM all_tab_columns
        WHERE owner = 'MODBUS_ADMIN' AND table_name = 'DEVICES'
          AND column_name IN ('LATITUDE','LONGITUDE','ALTITUDE','GPS_UPDATED_AT')
        ORDER BY column_name`
    );
    console.log('Present GPS columns:', (r.rows || []).map((row) => row[0]).join(', ') || '(none)');
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exitCode = 1;
  } finally {
    await conn.close().catch(() => {});
    process.exit(process.exitCode || 0);
  }
})();
