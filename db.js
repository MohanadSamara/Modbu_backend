const oracledb = require('oracledb');
require('dotenv').config();

// ── Pool configuration ────────────────────────────────────────────────────
const POOL_ALIAS = 'modbus_pool';

const poolConfig = {
  user:             process.env.ORACLE_USER,
  password:         process.env.ORACLE_PASSWORD,
  connectionString: `${process.env.ORACLE_HOST}:${process.env.ORACLE_PORT}/${process.env.ORACLE_SERVICE_NAME}`,
  poolAlias:        POOL_ALIAS,

  // Keep 2–5 connections alive at all times; scale up to 10 under load
  poolMin:          2,
  poolMax:          10,
  poolIncrement:    1,

  // Return idle connections to the pool after 60 s of inactivity
  poolTimeout:      60,

  // Ping the DB before handing a connection out — drops stale sockets
  // automatically after network blips or Oracle session timeouts
  pingInterval:     60,   // seconds

  // OracleDB will retry getting a pooled connection for up to 10 s
  // before throwing (handles brief DB unavailability without crashing)
  queueTimeout:     10000,
};

let _poolReady = false;
let _poolError = null;

// ── Initialise pool (call once at startup) ────────────────────────────────
async function initPool() {
  if (_poolReady) return true;
  try {
    await oracledb.createPool(poolConfig);
    _poolReady = true;
    _poolError = null;
    console.log('[DB] Connection pool created (min=2, max=10)');
    return true;
  } catch (err) {
    _poolError = err.message;
    console.error('[DB] Pool creation failed:', err.message);
    return false;
  }
}

// ── Get a connection from the pool ────────────────────────────────────────
// Callers must call conn.close() when done — this returns it to the pool,
// it does NOT drop the TCP connection.
async function getConnection() {
  // If pool isn't ready yet, try to create it now (lazy init / auto-recover)
  if (!_poolReady) {
    const ok = await initPool();
    if (!ok) {
      console.error('[DB] Pool unavailable:', _poolError);
      return null;
    }
  }

  try {
    const conn = await oracledb.getPool(POOL_ALIAS).getConnection();
    return conn;
  } catch (err) {
    console.error('[DB] getConnection failed:', err.message);

    // If the pool itself is dead (e.g. DB restarted), attempt to recreate it
    if (/NJS-002|NJS-076|ORA-12541|ORA-01034/i.test(err.message)) {
      console.warn('[DB] Attempting pool recreation…');
      _poolReady = false;
      try {
        // Close old pool gracefully before making a new one
        await oracledb.getPool(POOL_ALIAS).close(0).catch(() => {});
      } catch (_) {}
      await initPool();
    }

    return null;
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────
async function closePool() {
  if (!_poolReady) return;
  try {
    await oracledb.getPool(POOL_ALIAS).close(10); // drain over 10 s
    _poolReady = false;
    console.log('[DB] Pool closed');
  } catch (err) {
    console.warn('[DB] Pool close error:', err.message);
  }
}

// ── Log device action ─────────────────────────────────────────────────────
// Uses an Oracle sequence (lazy-created) for action_id instead of the old
// `SELECT MAX(action_id)+1` pattern, which was O(N) on every insert and got
// slower as the table grew. The sequence call + INSERT are also collapsed
// into a single PL/SQL round-trip (was 2 round-trips → 1).
async function logDeviceAction(deviceId, actionType) {
  const connection = await getConnection();
  if (!connection) { console.warn('[DB] Unavailable — skipping action log'); return false; }
  try {
    const useSeq = await _ensureActionSeq(connection);
    if (useSeq) {
      // One round-trip: sequence NEXTVAL + INSERT inline.
      await connection.execute(
        `INSERT INTO MODBUS_ADMIN.device_actions (action_id, device_id, action_type, action_time)
         VALUES (MODBUS_ADMIN.device_action_seq.NEXTVAL, :deviceId, :actionType, SYSTIMESTAMP)`,
        { deviceId, actionType },
        { autoCommit: true }
      );
    } else {
      // Fallback path (sequence couldn't be created — e.g. perms issue).
      const maxResult = await connection.execute(
        'SELECT NVL(MAX(action_id), 0) + 1 AS next_id FROM MODBUS_ADMIN.device_actions'
      );
      const nextId = maxResult.rows[0][0];
      await connection.execute(
        `INSERT INTO MODBUS_ADMIN.device_actions (action_id, device_id, action_type, action_time)
         VALUES (:actionId, :deviceId, :actionType, SYSTIMESTAMP)`,
        { actionId: nextId, deviceId, actionType },
        { autoCommit: true }
      );
    }
    console.log(`[DB] Logged ${actionType} for device ${deviceId}`);
    return true;
  } catch (err) {
    console.error('[DB] logDeviceAction failed:', err.message);
    return false;
  } finally {
    await connection.close().catch(() => {});
  }
}

// ── Sequence-backed action_id allocator ───────────────────────────────────
// Same lazy-create strategy as device_reading_seq below.
let _actionSeqReady = false;
let _actionSeqAvailable = false;

async function _ensureActionSeq(connection) {
  if (_actionSeqReady) return _actionSeqAvailable;
  _actionSeqReady = true;
  try {
    await connection.execute(`
      DECLARE
        v_count NUMBER;
        v_start NUMBER;
      BEGIN
        SELECT COUNT(*) INTO v_count FROM user_sequences WHERE sequence_name = 'DEVICE_ACTION_SEQ';
        IF v_count = 0 THEN
          SELECT NVL(MAX(action_id), 0) + 1 INTO v_start FROM MODBUS_ADMIN.device_actions;
          EXECUTE IMMEDIATE 'CREATE SEQUENCE MODBUS_ADMIN.device_action_seq START WITH ' || v_start || ' INCREMENT BY 1 NOCACHE NOORDER';
        END IF;
      END;
    `);
    _actionSeqAvailable = true;
    console.log('[DB] device_action_seq ready');
  } catch (err) {
    _actionSeqAvailable = false;
    console.warn('[DB] Could not create device_action_seq, falling back to MAX+1:', err.message);
  }
  return _actionSeqAvailable;
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
    // Prefer single-round-trip insert using NEXTVAL inline.
    // Falls back to MAX+1 only if the sequence couldn't be created.
    const useSeq = await _ensureReadingSeq(connection);
    if (useSeq) {
      await connection.execute(
        `INSERT INTO MODBUS_ADMIN.device_readings
           (reading_id, device_id, reading_type, reading_value, reading_unit, reading_time)
         VALUES (MODBUS_ADMIN.device_reading_seq.NEXTVAL, :deviceId, 'FUEL', :fuelValue, '%', SYSTIMESTAMP)`,
        { deviceId, fuelValue },
        { autoCommit: true }
      );
    } else {
      const maxResult = await connection.execute(
        'SELECT NVL(MAX(reading_id), 0) + 1 AS next_id FROM MODBUS_ADMIN.device_readings'
      );
      const nextId = maxResult.rows[0][0];
      await connection.execute(
        `INSERT INTO MODBUS_ADMIN.device_readings
           (reading_id, device_id, reading_type, reading_value, reading_unit, reading_time)
         VALUES (:readingId, :deviceId, 'FUEL', :fuelValue, '%', SYSTIMESTAMP)`,
        { readingId: nextId, deviceId, fuelValue },
        { autoCommit: true }
      );
    }
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

// ── Sequence-backed reading_id allocator ──────────────────────────────────
// `SELECT MAX(reading_id)+1` is O(N) on every insert and gets slower as
// device_readings grows. We prefer an Oracle sequence (O(1)). On the first
// call we lazily create the sequence seeded above the current MAX so it
// works on existing databases without a migration step.
let _readingSeqReady = false;
let _readingSeqAvailable = false; // false = fall back to MAX+1

async function _ensureReadingSeq(connection) {
  if (_readingSeqReady) return _readingSeqAvailable;
  _readingSeqReady = true;
  try {
    // Create sequence if missing, starting above the current MAX.
    await connection.execute(`
      DECLARE
        v_count NUMBER;
        v_max   NUMBER;
        v_start NUMBER;
      BEGIN
        SELECT COUNT(*) INTO v_count FROM user_sequences WHERE sequence_name = 'DEVICE_READING_SEQ';
        IF v_count = 0 THEN
          SELECT NVL(MAX(reading_id), 0) + 1 INTO v_start FROM MODBUS_ADMIN.device_readings;
          EXECUTE IMMEDIATE 'CREATE SEQUENCE MODBUS_ADMIN.device_reading_seq START WITH ' || v_start || ' INCREMENT BY 1 NOCACHE NOORDER';
        END IF;
      END;
    `);
    _readingSeqAvailable = true;
    console.log('[DB] device_reading_seq ready');
  } catch (err) {
    _readingSeqAvailable = false;
    console.warn('[DB] Could not create device_reading_seq, falling back to MAX+1:', err.message);
  }
  return _readingSeqAvailable;
}

async function _nextReadingId(connection) {
  const useSeq = await _ensureReadingSeq(connection);
  if (useSeq) {
    try {
      const r = await connection.execute(
        'SELECT MODBUS_ADMIN.device_reading_seq.NEXTVAL FROM dual'
      );
      return r.rows[0][0];
    } catch (err) {
      // Sequence vanished or perms changed — disable and fall back permanently.
      console.warn('[DB] Sequence NEXTVAL failed, disabling:', err.message);
      _readingSeqAvailable = false;
    }
  }
  const maxResult = await connection.execute(
    'SELECT NVL(MAX(reading_id), 0) + 1 AS next_id FROM MODBUS_ADMIN.device_readings'
  );
  return maxResult.rows[0][0];
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
         FROM MODBUS_ADMIN.device_readings
        WHERE device_id = :deviceId
          AND reading_type = 'FUEL'
          AND reading_time >= SYSTIMESTAMP - NUMTODSINTERVAL(:win, 'MINUTE')
        ORDER BY reading_time ASC`,
      { deviceId, win: windowMinutes }
    );
    const rows = result.rows || [];
    if (rows.length < minSamples) return null;

    // Convert to numeric (value, ms-since-epoch) pairs
    const samples = rows.map(r => ({
      v: Number(r[0]),
      t: new Date(r[1]).getTime(),
    })).filter(s => !isNaN(s.v) && !isNaN(s.t));

    if (samples.length < minSamples) return null;

    const first = samples[0];
    const last  = samples[samples.length - 1];
    const dtHours = (last.t - first.t) / 3_600_000;
    if (dtHours <= 0) return null;

    // Negative slope on fuel% = consumption. Report magnitude (%/h).
    const slopePerHour = (last.v - first.v) / dtHours;
    const consumption = -slopePerHour; // positive when burning fuel

    const value = {
      ratePerHour: Number(consumption.toFixed(3)),
      samples: samples.length,
      windowMinutes,
      firstValue: first.v,
      lastValue:  last.v,
      firstTime:  new Date(first.t).toISOString(),
      lastTime:   new Date(last.t).toISOString(),
    };
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
         FROM MODBUS_ADMIN.device_actions
        WHERE device_id = :deviceId
          AND action_type = :alarmType
        ORDER BY action_time DESC
        FETCH FIRST 1 ROWS ONLY`,
      { deviceId, alarmType }
    );
    const rows = result.rows || [];
    const value = rows.length === 0 ? null : {
      id:   rows[0][0],
      type: rows[0][1],
      time: rows[0][2],
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

  const maybeFire = async (type, message, extra = {}) => {
    const last = await getLastAlarm(deviceId, type);
    if (last && last.time) {
      const lastMs = new Date(last.time).getTime();
      if (now - lastMs < cooldownMs) {
        return; // still in cooldown — skip duplicate alarm
      }
    }
    await logDeviceAction(deviceId, type);
    // Update the last-alarm cache so the cooldown check on the next poll
    // doesn't need to hit the DB and doesn't see stale data.
    _lastAlarmCache.set(`${deviceId}|${type}`, {
      value: { id: null, type, time: new Date(now) },
      ts: Date.now(),
    });
    triggered.push({ type, message, time: new Date().toISOString(), ...extra });
    console.warn(`[ALARM] device=${deviceId} ${type} — ${message}`);
  };

  // 1. Critical tank (must be checked before low — only fire the most severe)
  if (typeof thresholds.criticalTank === 'number' &&
      fuelValue <= thresholds.criticalTank) {
    await maybeFire(
      'ALARM_CRITICAL_FUEL',
      `Fuel critically low: ${fuelValue}% (<= ${thresholds.criticalTank}%)`,
      { fuel: fuelValue, threshold: thresholds.criticalTank, severity: 'critical' }
    );
  } else if (typeof thresholds.lowTank === 'number' &&
             fuelValue <= thresholds.lowTank) {
    await maybeFire(
      'ALARM_LOW_FUEL',
      `Fuel low: ${fuelValue}% (<= ${thresholds.lowTank}%)`,
      { fuel: fuelValue, threshold: thresholds.lowTank, severity: 'warning' }
    );
  }

  // 2. Consumption-rate alarm
  const consumption = await getConsumptionRate(deviceId);
  if (consumption &&
      typeof thresholds.consumptionRate === 'number' &&
      consumption.ratePerHour >= thresholds.consumptionRate) {
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

  return { triggered, consumption };
}

module.exports = {
  initPool,
  closePool,
  getConnection,
  logDeviceAction,
  logFuelReading,
  getConsumptionRate,
  getLastAlarm,
  checkFuelAlarms,
  oracledb,
};
