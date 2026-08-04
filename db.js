const { Pool } = require('pg');
const { computeConsumption } = require('./lib/telemetry-math');
const rbac = require('./rbac-defaults');
require('dotenv').config();

// ── Pool ───────────────────────────────────────────────────────────────────
let pool = null;

function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool = new Pool({
    connectionString,
    max: 10,
    // Neon (and most managed Postgres hosts) require TLS but present a cert
    // chain the default Node trust store doesn't validate; local dev
    // Postgres has no TLS listener at all.
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
  });
  pool.on('error', (err) => console.error('[DB] Idle pool client error:', err.message));
  return pool;
}

async function initPool() {
  try {
    const client = await getPool().connect();
    client.release();
    console.log('[DB] Connection pool ready');
    return true;
  } catch (err) {
    console.error('[DB] Pool creation failed:', err.message);
    return false;
  }
}

async function closePool() {
  if (!pool) return;
  try {
    await pool.end();
    pool = null;
    console.log('[DB] Pool closed');
  } catch (err) {
    console.warn('[DB] Pool close error:', err.message);
  }
}

// ── Named-bind SQL translation ────────────────────────────────────────────
// Every call site across the backend still writes Oracle-style `:name` bind
// placeholders — either with a `{name: value}` object, or (a handful of call
// sites) a plain array, which oracledb binds positionally by order of
// appearance regardless of the placeholder's name. This translates either
// form into Postgres's `$1, $2, …` placeholders so none of those call sites
// had to be rewritten one-by-one.
function toPositional(sql, binds) {
  if (Array.isArray(binds)) {
    let i = 0;
    const text = sql.replace(/:[a-zA-Z_][a-zA-Z0-9_]*/g, () => `$${++i}`);
    return { text, values: binds };
  }
  if (binds && typeof binds === 'object') {
    const values = [];
    const paramIndex = new Map();
    const text = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
      if (paramIndex.has(name)) return `$${paramIndex.get(name)}`;
      values.push(binds[name]);
      paramIndex.set(name, values.length);
      return `$${values.length}`;
    });
    return { text, values };
  }
  return { text: sql, values: [] };
}

// oracledb's OUT_FORMAT_OBJECT returned UPPERCASE column/alias names, and
// every existing call site reads rows that way (row.DEVICE_ID, row.STATUS…).
// Postgres always lowercases unquoted identifiers, so rows are normalised
// back to uppercase keys here rather than touching every call site.
function toUppercaseRows(rows) {
  return rows.map((row) => {
    const out = {};
    for (const key of Object.keys(row)) out[key.toUpperCase()] = row[key];
    return out;
  });
}

// Mimics the slice of the oracledb connection interface this codebase was
// written against (execute/commit/rollback/close) so call sites elsewhere
// didn't need to change shape. `execute(sql, binds, { autoCommit: false })`
// opens a real transaction on first use; later calls on the same connection
// stay inside it until commit()/rollback(). close() rolls back anything left
// open — mirroring what returning an uncommitted oracledb connection to its
// pool used to do — and always releases the underlying client.
async function getConnection() {
  let client;
  try {
    client = await getPool().connect();
  } catch (err) {
    console.error('[DB] getConnection failed:', err.message);
    return null;
  }
  let inTransaction = false;
  return {
    async execute(sql, binds = [], options = {}) {
      const { text, values } = toPositional(sql, binds);
      if (options.autoCommit === false && !inTransaction) {
        await client.query('BEGIN');
        inTransaction = true;
      }
      const result = await client.query(text, values);
      return { rows: toUppercaseRows(result.rows), rowsAffected: result.rowCount };
    },
    async commit() {
      if (inTransaction) { await client.query('COMMIT'); inTransaction = false; }
    },
    async rollback() {
      if (inTransaction) { await client.query('ROLLBACK').catch(() => {}); inTransaction = false; }
    },
    async close() {
      if (inTransaction) await client.query('ROLLBACK').catch(() => {});
      client.release();
    },
  };
}

// ── Log device action ─────────────────────────────────────────────────────
async function logDeviceAction(deviceId, actionType) {
  const connection = await getConnection();
  if (!connection) { console.warn('[DB] Unavailable — skipping action log'); return false; }
  try {
    await connection.execute(
      `INSERT INTO device_actions (device_id, action_type, action_time)
       VALUES (:deviceId, :actionType, NOW())`,
      { deviceId, actionType },
      { autoCommit: true }
    );
    console.log(`[DB] Logged ${actionType} for device ${deviceId}`);
    return true;
  } catch (err) {
    console.error('[DB] logDeviceAction failed:', err.message);
    return false;
  } finally {
    await connection.close().catch(() => {});
  }
}

// ── Log fuel reading ──────────────────────────────────────────────────────
// In-memory cache of the last logged fuel value per device. We use this to
// skip writes when the value hasn't changed — most polls produce identical
// readings (e.g. 93.7% → 93.7%) and inserting them all wastes DB time and
// bloats device_readings, which slows every later MAX/consumption query.
//
// We still force a write every FUEL_LOG_HEARTBEAT_MS so the timeline keeps
// at least one sample per period even when fuel is perfectly steady.
const _lastFuelLog = new Map(); // deviceId -> { value, ts }
const FUEL_LOG_HEARTBEAT_MS = 5 * 60 * 1000; // 5 min

async function logFuelReading(deviceId, fuelValue) {
  // Skip duplicate readings — biggest perf win when polling every 1–2s.
  const prev = _lastFuelLog.get(deviceId);
  const now  = Date.now();
  if (prev && prev.value === fuelValue && (now - prev.ts) < FUEL_LOG_HEARTBEAT_MS) {
    return true; // unchanged — nothing to do
  }

  const connection = await getConnection();
  if (!connection) { console.warn('[DB] Unavailable — skipping fuel log'); return false; }
  try {
    await connection.execute(
      `INSERT INTO device_readings (device_id, reading_type, reading_value, reading_unit, reading_time)
       VALUES (:deviceId, 'FUEL', :fuelValue, '%', NOW())`,
      { deviceId, fuelValue },
      { autoCommit: true }
    );
    _lastFuelLog.set(deviceId, { value: fuelValue, ts: now });
    // New sample landed — drop any cached consumption result for this device
    // so the next alarm check recomputes against fresh data.
    for (const k of _consumptionCache.keys()) {
      if (k.startsWith(`${deviceId}|`)) _consumptionCache.delete(k);
    }
    console.log(`[DB] Logged FUEL ${fuelValue}% for device ${deviceId}`);
    return true;
  } catch (err) {
    console.error('[DB] logFuelReading failed:', err.message);
    return false;
  } finally {
    await connection.close().catch(() => {});
  }
}

// ── Compute consumption rate (% per hour) from recent readings ────────────
// Uses up to the last N fuel readings within `windowMinutes` and fits a simple
// linear slope. Positive value = fuel decreasing (consumption), reported as
// %/hour. Returns null if not enough data.
//
// Result is cached per (deviceId, windowMinutes) for CONSUMPTION_CACHE_MS so
// the alarm path on /api/modbus/fuel doesn't run a 60-min range scan on every
// poll. Cache is invalidated automatically whenever logFuelReading writes a
// new sample for that device (see _lastFuelLog write above).
const _consumptionCache = new Map(); // `${deviceId}|${win}` -> { value, ts }
const CONSUMPTION_CACHE_MS = 30_000; // 30s

async function getConsumptionRate(deviceId, windowMinutes = 60, minSamples = 2) {
  const cacheKey = `${deviceId}|${windowMinutes}`;
  const cached   = _consumptionCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < CONSUMPTION_CACHE_MS) {
    return cached.value;
  }

  const connection = await getConnection();
  if (!connection) return null;
  try {
    const result = await connection.execute(
      `SELECT reading_value, reading_time
         FROM device_readings
        WHERE device_id = :deviceId
          AND reading_type = 'FUEL'
          AND reading_time >= NOW() - (:win * INTERVAL '1 minute')
        ORDER BY reading_time ASC`,
      { deviceId, win: windowMinutes }
    );
    const rows = result.rows || [];

    // Convert to numeric (value, ms-since-epoch) pairs and let the pure helper
    // do the slope math (shared with the unit tests).
    const samples = rows.map(r => ({ v: Number(r.READING_VALUE), t: new Date(r.READING_TIME).getTime() }));
    const rate = computeConsumption(samples, minSamples);
    if (!rate) return null;

    const value = { ...rate, windowMinutes };
    _consumptionCache.set(cacheKey, { value, ts: Date.now() });
    return value;
  } catch (err) {
    console.error('[DB] getConsumptionRate failed:', err.message);
    return null;
  } finally {
    await connection.close().catch(() => {});
  }
}

// ── Get the most recent alarm of a given type for a device ────────────────
// Cached per (deviceId, alarmType) for LAST_ALARM_CACHE_MS. The only consumer
// (checkFuelAlarms) compares against `now - cooldownMs`, so a slightly stale
// timestamp is fine — at worst a new alarm fires a few seconds late.
// Cache is updated immediately when we fire a new alarm via logDeviceAction.
const _lastAlarmCache = new Map(); // `${deviceId}|${type}` -> { value, ts }
const LAST_ALARM_CACHE_MS = 60_000; // 60s

// Remembers, per (deviceId, type), whether the alarm condition was active on the
// previous poll. Lets checkFuelAlarms fire immediately on a fresh transition
// into the alarm state (and re-arm after a recovery) while still applying the
// time-cooldown to a condition that merely persists.
const _alarmActiveState = new Map(); // `${deviceId}|${type}` -> boolean

async function getLastAlarm(deviceId, alarmType) {
  const cacheKey = `${deviceId}|${alarmType}`;
  const cached   = _lastAlarmCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < LAST_ALARM_CACHE_MS) {
    return cached.value;
  }

  const connection = await getConnection();
  if (!connection) return null;
  try {
    const result = await connection.execute(
      `SELECT action_id, action_type, action_time
         FROM device_actions
        WHERE device_id = :deviceId
          AND action_type = :alarmType
        ORDER BY action_time DESC
        FETCH FIRST 1 ROWS ONLY`,
      { deviceId, alarmType }
    );
    const rows = result.rows || [];
    const value = rows.length === 0 ? null : {
      id:   rows[0].ACTION_ID,
      type: rows[0].ACTION_TYPE,
      time: rows[0].ACTION_TIME,
    };
    _lastAlarmCache.set(cacheKey, { value, ts: Date.now() });
    return value;
  } catch (err) {
    console.error('[DB] getLastAlarm failed:', err.message);
    return null;
  } finally {
    await connection.close().catch(() => {});
  }
}

// ── Dedicated alarms table ────────────────────────────────────────────────
// Active Alarms are stored in their own table (not reconstructed from the
// device_actions log). Every triggered alarm becomes one row here, carrying its
// severity/message/fuel context, and acknowledgment is tracked in-row. The
// device_actions ALARM_* rows are still written too, so the Events page and the
// stats "errors" bucket keep working — but this table is the authoritative
// source for GET /api/alarms.
async function ensureAlarmsTable() {
  const conn = await getConnection();
  if (!conn) return;
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS alarms (
        alarm_id        INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        device_id       INTEGER NOT NULL,
        alarm_type      VARCHAR(50) NOT NULL,
        severity        VARCHAR(16) NOT NULL,
        message         VARCHAR(400),
        fuel_value      NUMERIC,
        threshold_value NUMERIC,
        triggered_at    TIMESTAMP NOT NULL DEFAULT NOW(),
        acknowledged    INTEGER NOT NULL DEFAULT 0,
        acknowledged_by INTEGER,
        acknowledged_at TIMESTAMP,
        CONSTRAINT fk_alarm_device FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
      )
    `);
    await conn.execute(`CREATE INDEX IF NOT EXISTS ix_alarms_active ON alarms (acknowledged, triggered_at)`);
    console.log('[DB] alarms table ready');
  } catch (e) {
    console.warn('[DB] ensureAlarmsTable warning:', e.message);
  } finally {
    await conn.close().catch(() => {});
  }
}

// Persist one triggered alarm. Best-effort: a failure here must never break the
// fuel-poll path, so we log and move on (the device_actions row is still saved).
async function insertAlarm(deviceId, { type, severity, message = null, fuelValue = null, thresholdValue = null }) {
  const conn = await getConnection();
  if (!conn) { console.warn('[DB] Unavailable — skipping alarm insert'); return false; }
  try {
    await conn.execute(
      `INSERT INTO alarms (device_id, alarm_type, severity, message, fuel_value, threshold_value)
       VALUES (:deviceId, :type, :severity, :message, :fuelValue, :thresholdValue)`,
      {
        deviceId, type, severity,
        message,
        fuelValue:      typeof fuelValue === 'number' ? fuelValue : null,
        thresholdValue: typeof thresholdValue === 'number' ? thresholdValue : null,
      },
      { autoCommit: true }
    );
    return true;
  } catch (err) {
    console.error('[DB] insertAlarm failed:', err.message);
    return false;
  } finally {
    await conn.close().catch(() => {});
  }
}

// Active (un-acknowledged) alarms for the panel, newest first.
async function getActiveAlarms({ deviceId = null, limit = 50 } = {}) {
  const conn = await getConnection();
  if (!conn) return [];
  try {
    const capped = Math.max(1, Math.min(Number(limit) || 50, 500));
    const binds = { capped };
    let devClause = '';
    if (deviceId) { devClause = ' AND a.device_id = :deviceId'; binds.deviceId = deviceId; }
    const r = await conn.execute(
      `SELECT a.alarm_id, a.device_id,
              COALESCE(d.device_name, 'Device ' || a.device_id) AS device_name,
              a.alarm_type, a.triggered_at, a.severity, a.message
         FROM alarms a
         LEFT JOIN devices d ON d.device_id = a.device_id
        WHERE a.acknowledged = 0${devClause}
        ORDER BY a.triggered_at DESC
        LIMIT :capped`,
      binds
    );
    return (r.rows || []).map(row => ({
      id:         row.ALARM_ID,
      deviceId:   row.DEVICE_ID,
      deviceName: row.DEVICE_NAME,
      type:       row.ALARM_TYPE,
      time:       row.TRIGGERED_AT,
      severity:   row.SEVERITY,
      message:    row.MESSAGE,
    }));
  } catch (err) {
    console.error('[DB] getActiveAlarms failed:', err.message);
    return [];
  } finally {
    await conn.close().catch(() => {});
  }
}

// Mark an alarm acknowledged. Idempotent: acking an already-acked alarm is a
// no-op success. Returns { found, alarmId, deviceId } — found=false → 404.
async function acknowledgeAlarm(alarmId, userId = null) {
  const conn = await getConnection();
  if (!conn) return { found: false, error: 'DB unavailable' };
  try {
    const check = await conn.execute(
      'SELECT device_id FROM alarms WHERE alarm_id = :id',
      { id: alarmId }
    );
    if (!check.rows || check.rows.length === 0) return { found: false };
    const deviceId = check.rows[0].DEVICE_ID;
    await conn.execute(
      `UPDATE alarms
          SET acknowledged = 1, acknowledged_by = :userId, acknowledged_at = NOW()
        WHERE alarm_id = :id AND acknowledged = 0`,
      { userId, id: alarmId },
      { autoCommit: true }
    );
    return { found: true, alarmId, deviceId };
  } catch (err) {
    console.error('[DB] acknowledgeAlarm failed:', err.message);
    return { found: false, error: err.message };
  } finally {
    await conn.close().catch(() => {});
  }
}

// Auto-resolve: clear outstanding (un-acknowledged) alarms of the given types
// for a device once their condition no longer holds (e.g. the tank refilled
// above the threshold). Marks them acknowledged so they drop off the Active
// Alarms list and the alarm sound stops. Returns the number of rows cleared.
async function resolveAlarms(deviceId, types) {
  if (!Array.isArray(types) || types.length === 0) return 0;
  const conn = await getConnection();
  if (!conn) return 0;
  try {
    const binds = { deviceId };
    const placeholders = types.map((t, i) => { binds[`t${i}`] = t; return `:t${i}`; }).join(',');
    const r = await conn.execute(
      `UPDATE alarms
          SET acknowledged = 1, acknowledged_at = NOW()
        WHERE device_id = :deviceId
          AND acknowledged = 0
          AND alarm_type IN (${placeholders})`,
      binds,
      { autoCommit: true }
    );
    const cleared = r.rowsAffected || 0;
    if (cleared > 0) console.log(`[DB] Auto-resolved ${cleared} alarm(s) for device ${deviceId} (recovered)`);
    return cleared;
  } catch (err) {
    console.error('[DB] resolveAlarms failed:', err.message);
    return 0;
  } finally {
    await conn.close().catch(() => {});
  }
}

// ── Evaluate fuel reading vs thresholds and trigger alarms ────────────────
// thresholds: { lowTank, criticalTank, consumptionRate, alertsEnabled }
// Returns array of triggered alarm objects (also persisted to device_actions).
// Re-arms each alarm type after `cooldownMinutes` to avoid log spam.
async function checkFuelAlarms(deviceId, fuelValue, thresholds, options = {}) {
  const cooldownMinutes = options.cooldownMinutes ?? 5;
  const triggered = [];

  if (!thresholds || thresholds.alertsEnabled === false) {
    return { triggered, consumption: null };
  }

  const now = Date.now();
  const cooldownMs = cooldownMinutes * 60_000;

  const wasActive = (type) => _alarmActiveState.get(`${deviceId}|${type}`) === true;

  const maybeFire = async (type, message, extra = {}) => {
    // Fire immediately on a fresh transition into the alarm condition (the tank
    // just dropped below the threshold, possibly again after a recovery). Only
    // while the condition merely persists do we apply the time-cooldown, so an
    // accepted alarm re-appears after cooldown rather than every poll.
    if (wasActive(type)) {
      const last = await getLastAlarm(deviceId, type);
      if (last && last.time) {
        const lastMs = new Date(last.time).getTime();
        if (now - lastMs < cooldownMs) {
          return; // still in cooldown — skip duplicate alarm
        }
      }
    }
    await logDeviceAction(deviceId, type);
    // Save the alarm to the dedicated alarms table (source of truth for the
    // Active Alarms panel). Runs alongside the device_actions log write above.
    await insertAlarm(deviceId, {
      type,
      severity: extra.severity || (type === 'ALARM_CRITICAL_FUEL' ? 'critical' : 'warning'),
      message,
      fuelValue,
      thresholdValue: extra.threshold,
    });
    // Update the last-alarm cache so the cooldown check on the next poll
    // doesn't need to hit the DB and doesn't see stale data.
    _lastAlarmCache.set(`${deviceId}|${type}`, {
      value: { id: null, type, time: new Date(now) },
      ts: Date.now(),
    });
    triggered.push({ type, message, time: new Date().toISOString(), ...extra });
    console.warn(`[ALARM] device=${deviceId} ${type} — ${message}`);
  };

  // Evaluate each condition against the current reading. A type is "active"
  // while its condition holds; once it clears we auto-resolve any outstanding
  // alarm of that type so it stops on its own when the tank recovers.
  const criticalActive = typeof thresholds.criticalTank === 'number' && fuelValue <= thresholds.criticalTank;
  const lowActive      = typeof thresholds.lowTank === 'number'      && fuelValue <= thresholds.lowTank;

  // 1. Tank level (only fire the most severe; low is implied while critical).
  if (criticalActive) {
    await maybeFire(
      'ALARM_CRITICAL_FUEL',
      `Fuel critically low: ${fuelValue}% (<= ${thresholds.criticalTank}%)`,
      { fuel: fuelValue, threshold: thresholds.criticalTank, severity: 'critical' }
    );
  } else if (lowActive) {
    await maybeFire(
      'ALARM_LOW_FUEL',
      `Fuel low: ${fuelValue}% (<= ${thresholds.lowTank}%)`,
      { fuel: fuelValue, threshold: thresholds.lowTank, severity: 'warning' }
    );
  }

  // 2. Consumption-rate alarm
  const consumption = await getConsumptionRate(deviceId);
  const consumptionActive = !!consumption &&
    typeof thresholds.consumptionRate === 'number' &&
    consumption.ratePerHour >= thresholds.consumptionRate;
  if (consumptionActive) {
    await maybeFire(
      'ALARM_HIGH_CONSUMPTION',
      `High consumption: ${consumption.ratePerHour}%/h (>= ${thresholds.consumptionRate}%/h)`,
      {
        rate:      consumption.ratePerHour,
        threshold: thresholds.consumptionRate,
        samples:   consumption.samples,
        severity:  'warning',
      }
    );
  }

  // 3. Auto-resolve alarms whose condition no longer holds. Critical stays
  //    outstanding while low is still active (fuel <= lowTank), so we only clear
  //    critical once fuel climbs back above the critical threshold.
  const toResolve = [];
  if (!criticalActive)    toResolve.push('ALARM_CRITICAL_FUEL');
  if (!lowActive)         toResolve.push('ALARM_LOW_FUEL');
  if (!consumptionActive) toResolve.push('ALARM_HIGH_CONSUMPTION');
  if (toResolve.length) await resolveAlarms(deviceId, toResolve);

  // Remember this poll's condition states so the next poll can detect a fresh
  // transition (edge) vs. a persisting condition.
  _alarmActiveState.set(`${deviceId}|ALARM_CRITICAL_FUEL`, criticalActive);
  _alarmActiveState.set(`${deviceId}|ALARM_LOW_FUEL`, lowActive);
  _alarmActiveState.set(`${deviceId}|ALARM_HIGH_CONSUMPTION`, consumptionActive);

  return { triggered, consumption };
}

// ── Fuel history (for charts) ─────────────────────────────────────────────
// Returns raw FUEL samples for a device within the last `windowMinutes`, oldest
// first, capped at `limit` rows (most-recent kept when the window is dense).
async function getFuelHistory(deviceId, windowMinutes = 1440, limit = 500) {
  const connection = await getConnection();
  if (!connection) return [];
  try {
    const capped = Math.max(1, Math.min(Number(limit) || 500, 5000));
    const result = await connection.execute(
      `SELECT * FROM (
         SELECT reading_value, reading_time
           FROM device_readings
          WHERE device_id = :deviceId
            AND reading_type = 'FUEL'
            AND reading_time >= NOW() - (:win * INTERVAL '1 minute')
          ORDER BY reading_time DESC
          LIMIT :lim
       ) recent
       ORDER BY reading_time ASC`,
      { deviceId, win: windowMinutes, lim: capped }
    );
    return (result.rows || []).map(r => ({
      value: Number(r.READING_VALUE),
      time:  r.READING_TIME ? new Date(r.READING_TIME).toISOString() : null,
    }));
  } catch (err) {
    console.error('[DB] getFuelHistory failed:', err.message);
    return [];
  } finally {
    await connection.close().catch(() => {});
  }
}

// ── Raw event rows for the stats endpoint ─────────────────────────────────
// Pulls reading timestamps ("packets") and alarm-action timestamps ("errors")
// within the window so the caller can bucket them (see lib/telemetry-math).
async function getEventTimes(windowMinutes = 1440, deviceId = null) {
  const connection = await getConnection();
  if (!connection) return { readings: [], alarms: [] };
  try {
    const binds = { win: windowMinutes };
    let devClause = '';
    if (deviceId) { devClause = ' AND device_id = :deviceId'; binds.deviceId = deviceId; }

    const [rRes, aRes] = await Promise.all([
      connection.execute(
        `SELECT reading_time FROM device_readings
          WHERE reading_time >= NOW() - (:win * INTERVAL '1 minute')${devClause}`,
        binds
      ),
      connection.execute(
        `SELECT action_time FROM device_actions
          WHERE action_type LIKE 'ALARM_%'
            AND action_time >= NOW() - (:win * INTERVAL '1 minute')${devClause}`,
        binds
      ),
    ]);
    return {
      readings: (rRes.rows || []).map(r => new Date(r.READING_TIME).getTime()).filter(Number.isFinite),
      alarms:   (aRes.rows || []).map(r => new Date(r.ACTION_TIME).getTime()).filter(Number.isFinite),
    };
  } catch (err) {
    console.error('[DB] getEventTimes failed:', err.message);
    return { readings: [], alarms: [] };
  } finally {
    await connection.close().catch(() => {});
  }
}

// ── Alarm-snooze persistence ──────────────────────────────────────────────
// A snooze silences a device's alarm sound for every user until snooze_until
// (epoch-ms). Persisted so it survives a server restart (was in-memory only).
async function ensureSnoozeTable() {
  const conn = await getConnection();
  if (!conn) return;
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS device_snoozes (
        device_id    INTEGER PRIMARY KEY,
        snooze_until BIGINT NOT NULL,
        updated_by   INTEGER,
        updated_at   TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_snooze_device FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
      )
    `);
    console.log('[DB] device_snoozes table ready');
  } catch (e) {
    console.warn('[DB] ensureSnoozeTable warning:', e.message);
  } finally {
    await conn.close().catch(() => {});
  }
}

// Load all still-active snoozes as a Map(deviceId -> snoozeUntilMs). Expired
// rows are cleaned up opportunistically.
async function getActiveSnoozes() {
  const map = new Map();
  const conn = await getConnection();
  if (!conn) return map;
  try {
    const now = Date.now();
    const r = await conn.execute(`SELECT device_id, snooze_until FROM device_snoozes`);
    for (const row of r.rows || []) {
      const id = Number(row.DEVICE_ID);
      const until = Number(row.SNOOZE_UNTIL);
      if (Number.isFinite(until) && until > now) map.set(id, until);
    }
    // Best-effort cleanup of expired rows.
    conn.execute(
      `DELETE FROM device_snoozes WHERE snooze_until <= :now`,
      { now }, { autoCommit: true }
    ).catch(() => {});
    return map;
  } catch (e) {
    console.warn('[DB] getActiveSnoozes failed:', e.message);
    return map;
  } finally {
    await conn.close().catch(() => {});
  }
}

// Upsert (snoozeUntilMs > 0) or clear (<= 0) a device's snooze. Returns true on success.
async function setSnooze(deviceId, snoozeUntilMs, userId = null) {
  const conn = await getConnection();
  if (!conn) return false;
  try {
    if (!snoozeUntilMs || snoozeUntilMs <= 0) {
      await conn.execute(
        `DELETE FROM device_snoozes WHERE device_id = :deviceId`,
        { deviceId }, { autoCommit: true }
      );
      return true;
    }
    await conn.execute(
      `INSERT INTO device_snoozes (device_id, snooze_until, updated_by)
       VALUES (:deviceId, :until, :userId)
       ON CONFLICT (device_id) DO UPDATE
         SET snooze_until = EXCLUDED.snooze_until,
             updated_by   = EXCLUDED.updated_by,
             updated_at   = NOW()`,
      { deviceId, until: snoozeUntilMs, userId },
      { autoCommit: true }
    );
    return true;
  } catch (e) {
    console.warn('[DB] setSnooze failed:', e.message);
    return false;
  } finally {
    await conn.close().catch(() => {});
  }
}

// ── Project containers (nested projects) ──────────────────────────────────
// A project may live inside another project that acts as a container/folder.
// The projects table pre-dates the app (comes from the DB dump), so add the
// self-referencing parent_id column if it isn't there yet.
async function ensureProjectParentColumn() {
  const conn = await getConnection();
  if (!conn) return;
  try {
    await conn.execute(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS parent_id INTEGER`);
    console.log('[DB] projects.parent_id ready');
  } catch (e) {
    console.warn('[DB] ensureProjectParentColumn warning:', e.message);
  } finally {
    await conn.close().catch(() => {});
  }
}

// Would setting project `id`'s parent to `parentId` create a cycle? True when
// parentId is the project itself or any of its descendants. Walks up from the
// proposed parent through parent_id links looking for `id`.
async function projectParentWouldCycle(id, parentId) {
  if (parentId == null) return false;
  if (Number(parentId) === Number(id)) return true;
  const conn = await getConnection();
  if (!conn) return false;
  try {
    let cur = Number(parentId);
    const seen = new Set();
    while (cur != null && !seen.has(cur)) {
      if (cur === Number(id)) return true;
      seen.add(cur);
      const r = await conn.execute(
        `SELECT parent_id FROM projects WHERE id = :cur`,
        { cur }
      );
      const row = (r.rows || [])[0];
      cur = row && row.PARENT_ID != null ? Number(row.PARENT_ID) : null;
    }
    return false;
  } catch (e) {
    console.warn('[DB] projectParentWouldCycle failed:', e.message);
    return false;
  } finally {
    await conn.close().catch(() => {});
  }
}

// ── Datakom node name overrides ───────────────────────────────────────────
// Datakom Rainbow node names come from the cloud portal and can't be renamed
// there. This stores a per-node custom name shown INSTEAD of the cloud name,
// keyed by the frontend's node id (e.g. 'dk-node-1234'). The cloud is never
// touched — clearing the override reverts to the portal name.
async function ensureDatakomNodeNamesTable() {
  const conn = await getConnection();
  if (!conn) return;
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS datakom_node_names (
        node_id     VARCHAR(128) PRIMARY KEY,
        custom_name VARCHAR(200) NOT NULL,
        updated_by  INTEGER,
        updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    console.log('[DB] datakom_node_names table ready');
  } catch (e) {
    console.warn('[DB] ensureDatakomNodeNamesTable warning:', e.message);
  } finally {
    await conn.close().catch(() => {});
  }
}

// Return all overrides as { nodeId: customName }.
async function getDatakomNodeNames() {
  const out = {};
  const conn = await getConnection();
  if (!conn) return out;
  try {
    const r = await conn.execute(`SELECT node_id, custom_name FROM datakom_node_names`);
    for (const row of r.rows || []) out[String(row.NODE_ID)] = String(row.CUSTOM_NAME);
    return out;
  } catch (e) {
    console.warn('[DB] getDatakomNodeNames failed:', e.message);
    return out;
  } finally {
    await conn.close().catch(() => {});
  }
}

// Upsert a custom name for a node, or clear it when name is empty/null. Returns
// true on success.
async function setDatakomNodeName(nodeId, name, userId = null) {
  const conn = await getConnection();
  if (!conn) return false;
  try {
    const clean = (name ?? '').toString().trim();
    if (!clean) {
      await conn.execute(
        `DELETE FROM datakom_node_names WHERE node_id = :nodeId`,
        { nodeId }, { autoCommit: true }
      );
      return true;
    }
    await conn.execute(
      `INSERT INTO datakom_node_names (node_id, custom_name, updated_by)
       VALUES (:nodeId, :name, :userId)
       ON CONFLICT (node_id) DO UPDATE
         SET custom_name = EXCLUDED.custom_name,
             updated_by  = EXCLUDED.updated_by,
             updated_at  = NOW()`,
      { nodeId, name: clean, userId },
      { autoCommit: true }
    );
    return true;
  } catch (e) {
    console.warn('[DB] setDatakomNodeName failed:', e.message);
    return false;
  } finally {
    await conn.close().catch(() => {});
  }
}

// ── Datakom node containers (local grouping) ──────────────────────────────
// Cloud nodes are read-only on Datakom, but users can group them into local
// "container" folders. One row per node → the container name it belongs to.
// Nodes sharing a container name render together; clearing sends a node back
// to the top level.
async function ensureDatakomNodeContainersTable() {
  const conn = await getConnection();
  if (!conn) return;
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS datakom_node_containers (
        node_id        VARCHAR(128) PRIMARY KEY,
        container_name VARCHAR(200) NOT NULL,
        updated_by     INTEGER,
        updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    console.log('[DB] datakom_node_containers table ready');
  } catch (e) {
    console.warn('[DB] ensureDatakomNodeContainersTable warning:', e.message);
  } finally {
    await conn.close().catch(() => {});
  }
}

// Return all assignments as { nodeId: containerName }.
async function getDatakomNodeContainers() {
  const out = {};
  const conn = await getConnection();
  if (!conn) return out;
  try {
    const r = await conn.execute(`SELECT node_id, container_name FROM datakom_node_containers`);
    for (const row of r.rows || []) out[String(row.NODE_ID)] = String(row.CONTAINER_NAME);
    return out;
  } catch (e) {
    console.warn('[DB] getDatakomNodeContainers failed:', e.message);
    return out;
  } finally {
    await conn.close().catch(() => {});
  }
}

// Assign a node to a container, or clear it when the name is empty/null.
async function setDatakomNodeContainer(nodeId, container, userId = null) {
  const conn = await getConnection();
  if (!conn) return false;
  try {
    const clean = (container ?? '').toString().trim();
    if (!clean) {
      await conn.execute(
        `DELETE FROM datakom_node_containers WHERE node_id = :nodeId`,
        { nodeId }, { autoCommit: true }
      );
      return true;
    }
    await conn.execute(
      `INSERT INTO datakom_node_containers (node_id, container_name, updated_by)
       VALUES (:nodeId, :name, :userId)
       ON CONFLICT (node_id) DO UPDATE
         SET container_name = EXCLUDED.container_name,
             updated_by     = EXCLUDED.updated_by,
             updated_at     = NOW()`,
      { nodeId, name: clean, userId },
      { autoCommit: true }
    );
    return true;
  } catch (e) {
    console.warn('[DB] setDatakomNodeContainer failed:', e.message);
    return false;
  } finally {
    await conn.close().catch(() => {});
  }
}

// ── Datakom cloud→DB sync maps ────────────────────────────────────────────
// The sync job (datakom-sync.js) materialises the Datakom Rainbow cloud tree
// into real projects/locations/devices rows. These two tables are the
// idempotency anchors: a cloud node/device is matched by its map row, never by
// name, so user renames/moves/deletes are respected on later syncs.
//   datakom_node_map: node_key ('node:<id>' | 'folder:<name>' | 'ungrouped')
//     → the project or location the sync created for it.
//   datakom_did_map: did → the DEVICES row the sync created. The row doubles
//     as a tombstone: if the user deletes the device, the map row remains and
//     the sync never recreates it.
async function ensureDatakomSyncTables() {
  const conn = await getConnection();
  if (!conn) return;
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS datakom_node_map (
        node_key    VARCHAR(64) NOT NULL,
        entity_type VARCHAR(10) NOT NULL CHECK (entity_type IN ('project','location')),
        entity_id   INTEGER NOT NULL,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT pk_datakom_node_map PRIMARY KEY (node_key, entity_type)
      )
    `);
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS datakom_did_map (
        did        INTEGER PRIMARY KEY,
        device_id  INTEGER,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    console.log('[DB] datakom_node_map + datakom_did_map tables ready');
  } catch (e) {
    console.warn('[DB] ensureDatakomSyncTables warning:', e.message);
  } finally {
    await conn.close().catch(() => {});
  }
}

// ── Single system setting get/set ─────────────────────────────────────────
// Small helpers for backend-owned settings (e.g. DK_ADAPTER_ENABLED) that are
// read at boot / written by control routes, without going through the full
// /api/settings machinery.
async function getSystemSetting(key) {
  const conn = await getConnection();
  if (!conn) return null;
  try {
    const r = await conn.execute(
      `SELECT setting_value FROM system_settings WHERE setting_key = :key`,
      { key }
    );
    const v = r.rows?.[0]?.SETTING_VALUE;
    return v == null ? null : String(v);
  } catch (e) {
    console.warn('[DB] getSystemSetting failed:', e.message);
    return null;
  } finally {
    await conn.close().catch(() => {});
  }
}

async function setSystemSetting(key, value, type = 'string') {
  const conn = await getConnection();
  if (!conn) return false;
  try {
    await conn.execute(
      `INSERT INTO system_settings (setting_key, setting_value, setting_type)
       VALUES (:key, :value, :type)
       ON CONFLICT (setting_key) DO UPDATE
         SET setting_value = EXCLUDED.setting_value,
             setting_type  = EXCLUDED.setting_type,
             updated_at    = NOW()`,
      { key, value: String(value), type },
      { autoCommit: true }
    );
    return true;
  } catch (e) {
    console.warn('[DB] setSystemSetting failed:', e.message);
    return false;
  } finally {
    await conn.close().catch(() => {});
  }
}

// ── Page content overrides (admin visual editor) ──────────────────────────
// Stores the frontend's <Editable> overrides as a single JSON blob so design
// tweaks made by an admin are global — visible to every user on every device.
// One row keyed 'GLOBAL'.
async function ensurePageContentTable() {
  const conn = await getConnection();
  if (!conn) return;
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS page_content (
        content_key  VARCHAR(64) PRIMARY KEY,
        content_json TEXT NOT NULL,
        updated_by   INTEGER,
        updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    console.log('[DB] page_content table ready');
  } catch (e) {
    console.warn('[DB] ensurePageContentTable warning:', e.message);
  } finally {
    await conn.close().catch(() => {});
  }
}

// Return the stored overrides object (parsed). Empty object when unset / on error.
async function getPageContent(key = 'GLOBAL') {
  const conn = await getConnection();
  if (!conn) return {};
  try {
    const r = await conn.execute(
      `SELECT content_json FROM page_content WHERE content_key = :key`,
      { key }
    );
    const raw = r.rows?.[0]?.CONTENT_JSON;
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  } catch (e) {
    console.warn('[DB] getPageContent failed:', e.message);
    return {};
  } finally {
    await conn.close().catch(() => {});
  }
}

// Upsert the overrides object. `overrides` is a plain object; stored as JSON.
async function savePageContent(overrides, userId = null, key = 'GLOBAL') {
  const conn = await getConnection();
  if (!conn) return false;
  try {
    const json = JSON.stringify(overrides ?? {});
    await conn.execute(
      `INSERT INTO page_content (content_key, content_json, updated_by)
       VALUES (:key, :json, :userId)
       ON CONFLICT (content_key) DO UPDATE
         SET content_json = EXCLUDED.content_json,
             updated_by   = EXCLUDED.updated_by,
             updated_at   = NOW()`,
      { key, json, userId },
      { autoCommit: true }
    );
    return true;
  } catch (e) {
    console.warn('[DB] savePageContent failed:', e.message);
    return false;
  } finally {
    await conn.close().catch(() => {});
  }
}

// ── Settings tables (system-wide + per-device) ────────────────────────────
// These back GET/PUT /api/settings and /api/device-settings. Auto-created here
// (idempotently) so saving settings persists even on a DB where the initial
// migration was never applied.
async function ensureSettingsTables() {
  const conn = await getConnection();
  if (!conn) return;
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS system_settings (
        setting_id    INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        setting_key   VARCHAR(100) NOT NULL,
        setting_value VARCHAR(500),
        setting_type  VARCHAR(20) DEFAULT 'string',
        updated_at    TIMESTAMP DEFAULT NOW(),
        CONSTRAINT uq_system_settings_key UNIQUE (setting_key)
      )
    `);
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS device_settings (
        device_id     INTEGER NOT NULL,
        setting_key   VARCHAR(100) NOT NULL,
        setting_value VARCHAR(500),
        setting_type  VARCHAR(20) DEFAULT 'string',
        updated_at    TIMESTAMP DEFAULT NOW(),
        CONSTRAINT pk_device_settings PRIMARY KEY (device_id, setting_key)
      )
    `);
    console.log('[DB] system_settings + device_settings tables ready');
  } catch (e) {
    console.warn('[DB] ensureSettingsTables warning:', e.message);
  } finally {
    await conn.close().catch(() => {});
  }
}

// ── Seed built-in permissions + system roles ──────────────────────────────
// Idempotent, non-destructive startup seed so a fresh DB comes up fully
// populated. Inserts any MISSING built-in permission and any MISSING system
// role. A system role's default permissions are granted ONLY when the role is
// first created here — so an admin who later revokes/adds permissions on a
// system role won't have those changes clobbered on the next restart. Existing
// permission descriptions are likewise left untouched (insert-if-missing only).
//
// Assumes the permissions/roles/role_permissions tables already exist — they
// back login and the whole RBAC system, so the app can't run without them. If
// one is missing we log and move on, same as the other ensure* helpers. Use the
// Permissions/Roles "Reset to defaults" actions for a full destructive restore.
async function ensureRbacSeed() {
  const conn = await getConnection();
  if (!conn) return;
  try {
    // 1. Built-in permissions — insert missing ones only (keep admin edits).
    let newPerms = 0;
    for (const p of rbac.BUILTIN_PERMISSIONS) {
      const r = await conn.execute(
        `INSERT INTO permissions (permission_key, description, resource_type, access_level)
         VALUES (:k, :d, :r, :a)
         ON CONFLICT (permission_key) DO NOTHING`,
        { k: p.key, d: p.description, r: p.resource, a: p.level }
      );
      newPerms += r.rowsAffected || 0;
    }

    // 2. System roles — create missing ones and grant their default permissions
    //    on first creation only (never re-grant to an existing role).
    let newRoles = 0;
    for (const role of rbac.SYSTEM_ROLES) {
      const existing = await conn.execute(
        `SELECT role_id FROM roles WHERE role_key = :rk`,
        { rk: role.key }
      );
      if (existing.rows?.length) continue; // already present — leave it alone

      const ins = await conn.execute(
        `INSERT INTO roles (role_key, role_name, description, is_system, scope_level)
         VALUES (:rk, :rn, :rd, 1, :sl)
         RETURNING role_id`,
        { rk: role.key, rn: role.name, rd: role.description, sl: role.scopeLevel }
      );
      const roleId = ins.rows[0].ROLE_ID;
      newRoles++;

      for (const key of rbac.permissionKeysForRole(role)) {
        await conn.execute(
          `INSERT INTO role_permissions (role_id, permission_id)
           SELECT :rid, permission_id FROM permissions WHERE permission_key = :k`,
          { rid: roleId, k: key }
        );
      }
    }

    // 3. The admin role is the "full access" invariant — top it up with any
    //    built-in permission it's missing (additive only, never revokes). This
    //    makes newly added built-ins (e.g. datakom.*) usable by admins right
    //    after an upgrade without needing a manual Roles reset.
    const keyBinds = {};
    rbac.BUILTIN_PERMISSION_KEYS.forEach((k, i) => { keyBinds[`bk${i}`] = k; });
    const keyList = rbac.BUILTIN_PERMISSION_KEYS.map((_, i) => `:bk${i}`).join(',');
    const adminRes = await conn.execute(`SELECT role_id FROM roles WHERE role_key = 'admin'`);
    const adminId = adminRes.rows?.[0]?.ROLE_ID;
    let adminGranted = 0;
    if (adminId) {
      const g = await conn.execute(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT :rid, p.permission_id
           FROM permissions p
          WHERE p.permission_key IN (${keyList})
            AND NOT EXISTS (
              SELECT 1 FROM role_permissions rp
               WHERE rp.role_id = :rid AND rp.permission_id = p.permission_id
            )`,
        { rid: adminId, ...keyBinds }
      );
      adminGranted = g.rowsAffected || 0;
    }

    console.log(`[DB] RBAC seed ready (permissions: ${newPerms} new, roles: ${newRoles} new, admin grants: +${adminGranted})`);
  } catch (e) {
    console.warn('[DB] ensureRbacSeed warning:', e.message);
  } finally {
    await conn.close().catch(() => {});
  }
}

// ── UI element catalog (create + seed) ────────────────────────────────────
// The Permissions editor renders the granular UI elements (buttons/controls)
// from ui_element_catalog. On a DB where that table was never populated the
// editor silently falls back to a small static list, so we create the table
// (idempotently) and seed the full default catalog here. Seeding only inserts
// missing rows, so elements an admin has since edited or added are untouched.
async function ensureUiElementCatalog() {
  const conn = await getConnection();
  if (!conn) return;
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS ui_element_catalog (
        element_id VARCHAR(60) PRIMARY KEY,
        field      VARCHAR(40),
        label      VARCHAR(200),
        sort_order INTEGER DEFAULT 999
      )
    `);
    let inserted = 0;
    for (const el of rbac.UI_ELEMENT_CATALOG) {
      const r = await conn.execute(
        `INSERT INTO ui_element_catalog (element_id, field, label, sort_order)
         VALUES (:id, :field, :label, :sortOrder)
         ON CONFLICT (element_id) DO NOTHING`,
        { id: el.id, field: el.field, label: el.label, sortOrder: el.sortOrder }
      );
      inserted += r.rowsAffected || 0;
    }
    console.log(`[DB] ui_element_catalog ready (${rbac.UI_ELEMENT_CATALOG.length} defaults, ${inserted} newly seeded)`);
  } catch (e) {
    console.warn('[DB] ensureUiElementCatalog warning:', e.message);
  } finally {
    await conn.close().catch(() => {});
  }
}

// ── Restore default permissions ───────────────────────────────────────────
// Deletes every custom permission key, restores the built-in ones to their
// canonical definition, and rebuilds the default permission → UI-element
// mappings. Runs in a single transaction; returns { ok, error? }.
async function restoreDefaultPermissions() {
  const conn = await getConnection();
  if (!conn) return { ok: false, error: 'DB unavailable' };
  try {
    const keys = rbac.BUILTIN_PERMISSION_KEYS;
    const binds = {};
    keys.forEach((k, i) => { binds[`k${i}`] = k; });
    const inList = keys.map((_, i) => `:k${i}`).join(',');

    // 1. Drop custom permissions — role_permissions, permission_ui_elements and
    //    permission_endpoints rows referencing them cascade away.
    await conn.execute(
      `DELETE FROM permissions WHERE permission_key NOT IN (${inList})`,
      binds, { autoCommit: false }
    );

    // 2. Upsert the built-ins back to their canonical description/resource/level.
    for (const p of rbac.BUILTIN_PERMISSIONS) {
      await conn.execute(
        `INSERT INTO permissions (permission_key, description, resource_type, access_level)
         VALUES (:k, :d, :r, :a)
         ON CONFLICT (permission_key) DO UPDATE
           SET description = EXCLUDED.description,
               resource_type = EXCLUDED.resource_type,
               access_level = EXCLUDED.access_level`,
        { k: p.key, d: p.description, r: p.resource, a: p.level },
        { autoCommit: false }
      );
    }

    // 3. Rebuild the default element mappings from scratch.
    await conn.execute(`DELETE FROM permission_ui_elements`, [], { autoCommit: false });
    for (const m of rbac.defaultElementMappings()) {
      await conn.execute(
        `INSERT INTO permission_ui_elements (permission_key, element_id)
         VALUES (:k, :e)`,
        { k: m.permissionKey, e: m.elementId }, { autoCommit: false }
      );
    }

    await conn.commit();
    return { ok: true };
  } catch (e) {
    await conn.rollback().catch(() => {});
    console.error('[DB] restoreDefaultPermissions failed:', e.message);
    return { ok: false, error: e.message };
  } finally {
    await conn.close().catch(() => {});
  }
}

// ── Restore default role permissions ──────────────────────────────────────
// Ensures the built-in permissions and the three system roles exist, then
// resets each system role's granted permissions back to its default set.
// Custom roles and their permissions are left untouched. Returns { ok, error? }.
async function restoreDefaultRolePermissions() {
  const conn = await getConnection();
  if (!conn) return { ok: false, error: 'DB unavailable' };
  try {
    // Grants reference the built-in permissions, so make sure they exist first.
    for (const p of rbac.BUILTIN_PERMISSIONS) {
      await conn.execute(
        `INSERT INTO permissions (permission_key, description, resource_type, access_level)
         VALUES (:k, :d, :r, :a)
         ON CONFLICT (permission_key) DO UPDATE
           SET description = EXCLUDED.description,
               resource_type = EXCLUDED.resource_type,
               access_level = EXCLUDED.access_level`,
        { k: p.key, d: p.description, r: p.resource, a: p.level },
        { autoCommit: false }
      );
    }

    for (const role of rbac.SYSTEM_ROLES) {
      // Ensure the system role exists (create if missing; never rename it here).
      await conn.execute(
        `INSERT INTO roles (role_key, role_name, description, is_system, scope_level)
         VALUES (:rk, :rn, :rd, 1, :sl)
         ON CONFLICT (role_key) DO UPDATE SET is_system = 1`,
        { rk: role.key, rn: role.name, rd: role.description, sl: role.scopeLevel },
        { autoCommit: false }
      );

      const rr = await conn.execute(
        `SELECT role_id FROM roles WHERE role_key = :rk`,
        { rk: role.key }, { autoCommit: false }
      );
      const roleId = rr.rows?.[0]?.ROLE_ID;
      if (!roleId) continue;

      // Reset this role's permissions to the default set.
      await conn.execute(
        `DELETE FROM role_permissions WHERE role_id = :rid`,
        { rid: roleId }, { autoCommit: false }
      );
      for (const key of rbac.permissionKeysForRole(role)) {
        await conn.execute(
          `INSERT INTO role_permissions (role_id, permission_id)
           SELECT :rid, permission_id FROM permissions WHERE permission_key = :k`,
          { rid: roleId, k: key }, { autoCommit: false }
        );
      }
    }

    await conn.commit();
    return { ok: true };
  } catch (e) {
    await conn.rollback().catch(() => {});
    console.error('[DB] restoreDefaultRolePermissions failed:', e.message);
    return { ok: false, error: e.message };
  } finally {
    await conn.close().catch(() => {});
  }
}

module.exports = {
  initPool,
  closePool,
  getConnection,
  ensurePageContentTable,
  ensureSettingsTables,
  ensureRbacSeed,
  ensureUiElementCatalog,
  restoreDefaultPermissions,
  restoreDefaultRolePermissions,
  getPageContent,
  savePageContent,
  logDeviceAction,
  logFuelReading,
  getConsumptionRate,
  getFuelHistory,
  getEventTimes,
  getLastAlarm,
  checkFuelAlarms,
  ensureAlarmsTable,
  insertAlarm,
  getActiveAlarms,
  acknowledgeAlarm,
  ensureSnoozeTable,
  getActiveSnoozes,
  setSnooze,
  ensureDatakomNodeNamesTable,
  getDatakomNodeNames,
  setDatakomNodeName,
  ensureDatakomNodeContainersTable,
  getDatakomNodeContainers,
  setDatakomNodeContainer,
  ensureDatakomSyncTables,
  getSystemSetting,
  setSystemSetting,
  ensureProjectParentColumn,
  projectParentWouldCycle,
};
