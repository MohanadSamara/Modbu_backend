const oracledb = require('oracledb');
const { computeConsumption } = require('./lib/telemetry-math');
const rbac = require('./rbac-defaults');
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

    // Convert to numeric (value, ms-since-epoch) pairs and let the pure helper
    // do the slope math (shared with the unit tests).
    const samples = rows.map(r => ({ v: Number(r[0]), t: new Date(r[1]).getTime() }));
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
      BEGIN
        EXECUTE IMMEDIATE 'CREATE SEQUENCE MODBUS_ADMIN.alarm_seq START WITH 1 INCREMENT BY 1 NOCACHE';
      EXCEPTION
        WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
      END;
    `);
    await conn.execute(`
      BEGIN
        EXECUTE IMMEDIATE 'CREATE TABLE MODBUS_ADMIN.alarms (
          alarm_id        NUMBER PRIMARY KEY,
          device_id       NUMBER NOT NULL,
          alarm_type      VARCHAR2(50) NOT NULL,
          severity        VARCHAR2(16) NOT NULL,
          message         VARCHAR2(400),
          fuel_value      NUMBER,
          threshold_value NUMBER,
          triggered_at    TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
          acknowledged    NUMBER(1) DEFAULT 0 NOT NULL,
          acknowledged_by NUMBER,
          acknowledged_at TIMESTAMP,
          CONSTRAINT fk_alarm_device FOREIGN KEY (device_id)
            REFERENCES MODBUS_ADMIN.devices(device_id) ON DELETE CASCADE
        )';
      EXCEPTION
        WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
      END;
    `);
    // Index for the Active Alarms query (un-acknowledged, newest first).
    await conn.execute(`
      BEGIN
        EXECUTE IMMEDIATE 'CREATE INDEX MODBUS_ADMIN.ix_alarms_active ON MODBUS_ADMIN.alarms(acknowledged, triggered_at)';
      EXCEPTION
        WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
      END;
    `);
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
      `INSERT INTO MODBUS_ADMIN.alarms
         (alarm_id, device_id, alarm_type, severity, message, fuel_value, threshold_value)
       VALUES (MODBUS_ADMIN.alarm_seq.NEXTVAL, :deviceId, :type, :severity, :message, :fuelValue, :thresholdValue)`,
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
    const binds = {};
    let devClause = '';
    if (deviceId) { devClause = ' AND a.device_id = :deviceId'; binds.deviceId = deviceId; }
    const r = await conn.execute(
      `SELECT * FROM (
         SELECT a.alarm_id, a.device_id,
                NVL(d.device_name, 'Device ' || a.device_id) AS device_name,
                a.alarm_type, a.triggered_at, a.severity, a.message
           FROM MODBUS_ADMIN.alarms a
           LEFT JOIN MODBUS_ADMIN.devices d ON d.device_id = a.device_id
          WHERE a.acknowledged = 0${devClause}
          ORDER BY a.triggered_at DESC
       ) WHERE ROWNUM <= ${capped}`,
      binds
    );
    return (r.rows || []).map(row => ({
      id:         row[0],
      deviceId:   row[1],
      deviceName: row[2],
      type:       row[3],
      time:       row[4],
      severity:   row[5],
      message:    row[6],
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
      'SELECT device_id FROM MODBUS_ADMIN.alarms WHERE alarm_id = :id',
      { id: alarmId }
    );
    if (!check.rows || check.rows.length === 0) return { found: false };
    const deviceId = check.rows[0][0];
    await conn.execute(
      `UPDATE MODBUS_ADMIN.alarms
          SET acknowledged = 1, acknowledged_by = :userId, acknowledged_at = SYSTIMESTAMP
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
      `UPDATE MODBUS_ADMIN.alarms
          SET acknowledged = 1, acknowledged_at = SYSTIMESTAMP
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
           FROM MODBUS_ADMIN.device_readings
          WHERE device_id = :deviceId
            AND reading_type = 'FUEL'
            AND reading_time >= SYSTIMESTAMP - NUMTODSINTERVAL(:win, 'MINUTE')
          ORDER BY reading_time DESC
       ) WHERE ROWNUM <= :lim
       ORDER BY reading_time ASC`,
      { deviceId, win: windowMinutes, lim: capped }
    );
    return (result.rows || []).map(r => ({
      value: Number(r[0]),
      time:  r[1] ? new Date(r[1]).toISOString() : null,
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
        `SELECT reading_time FROM MODBUS_ADMIN.device_readings
          WHERE reading_time >= SYSTIMESTAMP - NUMTODSINTERVAL(:win, 'MINUTE')${devClause}`,
        binds
      ),
      connection.execute(
        `SELECT action_time FROM MODBUS_ADMIN.device_actions
          WHERE action_type LIKE 'ALARM_%'
            AND action_time >= SYSTIMESTAMP - NUMTODSINTERVAL(:win, 'MINUTE')${devClause}`,
        binds
      ),
    ]);
    return {
      readings: (rRes.rows || []).map(r => new Date(r[0]).getTime()).filter(Number.isFinite),
      alarms:   (aRes.rows || []).map(r => new Date(r[0]).getTime()).filter(Number.isFinite),
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
      BEGIN
        EXECUTE IMMEDIATE 'CREATE TABLE MODBUS_ADMIN.device_snoozes (
          device_id    NUMBER PRIMARY KEY,
          snooze_until NUMBER NOT NULL,
          updated_by   NUMBER,
          updated_at   TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
          CONSTRAINT fk_snooze_device FOREIGN KEY (device_id)
            REFERENCES MODBUS_ADMIN.devices(device_id) ON DELETE CASCADE
        )';
      EXCEPTION
        WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
      END;
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
    const r = await conn.execute(
      `SELECT device_id, snooze_until FROM MODBUS_ADMIN.device_snoozes`
    );
    for (const row of r.rows || []) {
      const id = Number(row[0]);
      const until = Number(row[1]);
      if (Number.isFinite(until) && until > now) map.set(id, until);
    }
    // Best-effort cleanup of expired rows.
    conn.execute(
      `DELETE FROM MODBUS_ADMIN.device_snoozes WHERE snooze_until <= :now`,
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
        `DELETE FROM MODBUS_ADMIN.device_snoozes WHERE device_id = :deviceId`,
        { deviceId }, { autoCommit: true }
      );
      return true;
    }
    const upd = await conn.execute(
      `UPDATE MODBUS_ADMIN.device_snoozes
          SET snooze_until = :until, updated_by = :userId, updated_at = SYSTIMESTAMP
        WHERE device_id = :deviceId`,
      { until: snoozeUntilMs, userId, deviceId }, { autoCommit: false }
    );
    if ((upd.rowsAffected || 0) === 0) {
      await conn.execute(
        `INSERT INTO MODBUS_ADMIN.device_snoozes (device_id, snooze_until, updated_by)
         VALUES (:deviceId, :until, :userId)`,
        { deviceId, until: snoozeUntilMs, userId }, { autoCommit: false }
      );
    }
    await conn.commit();
    return true;
  } catch (e) {
    await conn.rollback().catch(() => {});
    console.warn('[DB] setSnooze failed:', e.message);
    return false;
  } finally {
    await conn.close().catch(() => {});
  }
}

// ── Project containers (nested projects) ──────────────────────────────────
// A project may live inside another project that acts as a container/folder.
// The projects table pre-dates the app (comes from the DB dump), so add the
// self-referencing parent_id column if it isn't there yet. ORA-01430 = column
// already exists → ignore.
async function ensureProjectParentColumn() {
  const conn = await getConnection();
  if (!conn) return;
  try {
    await conn.execute(`
      BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE MODBUS_ADMIN.projects ADD (parent_id NUMBER)';
      EXCEPTION
        WHEN OTHERS THEN IF SQLCODE != -1430 THEN RAISE; END IF;
      END;
    `);
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
        `SELECT parent_id FROM MODBUS_ADMIN.projects WHERE id = :cur`,
        { cur }, { outFormat: oracledb.OUT_FORMAT_OBJECT }
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
      BEGIN
        EXECUTE IMMEDIATE 'CREATE TABLE MODBUS_ADMIN.datakom_node_names (
          node_id     VARCHAR2(128) PRIMARY KEY,
          custom_name VARCHAR2(200) NOT NULL,
          updated_by  NUMBER,
          updated_at  TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
        )';
      EXCEPTION
        WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
      END;
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
    const r = await conn.execute(`SELECT node_id, custom_name FROM MODBUS_ADMIN.datakom_node_names`);
    for (const row of r.rows || []) out[String(row[0])] = String(row[1]);
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
        `DELETE FROM MODBUS_ADMIN.datakom_node_names WHERE node_id = :nodeId`,
        { nodeId }, { autoCommit: true }
      );
      return true;
    }
    const upd = await conn.execute(
      `UPDATE MODBUS_ADMIN.datakom_node_names
          SET custom_name = :name, updated_by = :userId, updated_at = SYSTIMESTAMP
        WHERE node_id = :nodeId`,
      { name: clean, userId, nodeId }, { autoCommit: false }
    );
    if ((upd.rowsAffected || 0) === 0) {
      await conn.execute(
        `INSERT INTO MODBUS_ADMIN.datakom_node_names (node_id, custom_name, updated_by)
         VALUES (:nodeId, :name, :userId)`,
        { nodeId, name: clean, userId }, { autoCommit: false }
      );
    }
    await conn.commit();
    return true;
  } catch (e) {
    await conn.rollback().catch(() => {});
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
      BEGIN
        EXECUTE IMMEDIATE 'CREATE TABLE MODBUS_ADMIN.datakom_node_containers (
          node_id        VARCHAR2(128) PRIMARY KEY,
          container_name VARCHAR2(200) NOT NULL,
          updated_by     NUMBER,
          updated_at     TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
        )';
      EXCEPTION
        WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
      END;
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
    const r = await conn.execute(`SELECT node_id, container_name FROM MODBUS_ADMIN.datakom_node_containers`);
    for (const row of r.rows || []) out[String(row[0])] = String(row[1]);
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
        `DELETE FROM MODBUS_ADMIN.datakom_node_containers WHERE node_id = :nodeId`,
        { nodeId }, { autoCommit: true }
      );
      return true;
    }
    const upd = await conn.execute(
      `UPDATE MODBUS_ADMIN.datakom_node_containers
          SET container_name = :name, updated_by = :userId, updated_at = SYSTIMESTAMP
        WHERE node_id = :nodeId`,
      { name: clean, userId, nodeId }, { autoCommit: false }
    );
    if ((upd.rowsAffected || 0) === 0) {
      await conn.execute(
        `INSERT INTO MODBUS_ADMIN.datakom_node_containers (node_id, container_name, updated_by)
         VALUES (:nodeId, :name, :userId)`,
        { nodeId, name: clean, userId }, { autoCommit: false }
      );
    }
    await conn.commit();
    return true;
  } catch (e) {
    await conn.rollback().catch(() => {});
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
      BEGIN
        EXECUTE IMMEDIATE 'CREATE TABLE MODBUS_ADMIN.datakom_node_map (
          node_key    VARCHAR2(64) NOT NULL,
          entity_type VARCHAR2(10) NOT NULL CHECK (entity_type IN (''project'',''location'')),
          entity_id   NUMBER NOT NULL,
          created_at  TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
          CONSTRAINT pk_datakom_node_map PRIMARY KEY (node_key, entity_type)
        )';
      EXCEPTION
        WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
      END;
    `);
    await conn.execute(`
      BEGIN
        EXECUTE IMMEDIATE 'CREATE TABLE MODBUS_ADMIN.datakom_did_map (
          did        NUMBER PRIMARY KEY,
          device_id  NUMBER,
          created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
        )';
      EXCEPTION
        WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
      END;
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
      `SELECT setting_value FROM MODBUS_ADMIN.system_settings WHERE setting_key = :key`,
      { key }
    );
    const v = r.rows?.[0]?.[0];
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
    const upd = await conn.execute(
      `UPDATE MODBUS_ADMIN.system_settings
          SET setting_value = :value, setting_type = :type, updated_at = SYSTIMESTAMP
        WHERE setting_key = :key`,
      { key, value: String(value), type }, { autoCommit: false }
    );
    if ((upd.rowsAffected || 0) === 0) {
      await conn.execute(
        `INSERT INTO MODBUS_ADMIN.system_settings (setting_key, setting_value, setting_type)
         VALUES (:key, :value, :type)`,
        { key, value: String(value), type }, { autoCommit: false }
      );
    }
    await conn.commit();
    return true;
  } catch (e) {
    await conn.rollback().catch(() => {});
    console.warn('[DB] setSystemSetting failed:', e.message);
    return false;
  } finally {
    await conn.close().catch(() => {});
  }
}

// ── Page content overrides (admin visual editor) ──────────────────────────
// Stores the frontend's <Editable> overrides as a single JSON blob so design
// tweaks made by an admin are global — visible to every user on every device.
// One row keyed 'GLOBAL'; content_json is a CLOB so the blob can grow without
// hitting a VARCHAR2 length cap.
async function ensurePageContentTable() {
  const conn = await getConnection();
  if (!conn) return;
  try {
    await conn.execute(`
      BEGIN
        EXECUTE IMMEDIATE 'CREATE TABLE MODBUS_ADMIN.page_content (
          content_key  VARCHAR2(64) PRIMARY KEY,
          content_json CLOB NOT NULL,
          updated_by   NUMBER,
          updated_at   TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
        )';
      EXCEPTION
        WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
      END;
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
      `SELECT content_json FROM MODBUS_ADMIN.page_content WHERE content_key = :key`,
      { key },
      // Fetch the CLOB directly as a string rather than a Lob stream.
      { fetchInfo: { CONTENT_JSON: { type: oracledb.STRING } } }
    );
    const raw = r.rows?.[0]?.[0];
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
    const upd = await conn.execute(
      `UPDATE MODBUS_ADMIN.page_content
          SET content_json = :json, updated_by = :userId, updated_at = SYSTIMESTAMP
        WHERE content_key = :key`,
      { json, userId, key }, { autoCommit: false }
    );
    if ((upd.rowsAffected || 0) === 0) {
      await conn.execute(
        `INSERT INTO MODBUS_ADMIN.page_content (content_key, content_json, updated_by)
         VALUES (:key, :json, :userId)`,
        { key, json, userId }, { autoCommit: false }
      );
    }
    await conn.commit();
    return true;
  } catch (e) {
    await conn.rollback().catch(() => {});
    console.warn('[DB] savePageContent failed:', e.message);
    return false;
  } finally {
    await conn.close().catch(() => {});
  }
}

// ── Settings tables (system-wide + per-device) ────────────────────────────
// These back GET/PUT /api/settings and /api/device-settings. They used to live
// in schema.sql (since removed from the repo), so on a DB where that script was
// never applied the settings endpoints failed with ORA-00942 and the frontend
// silently fell back to localStorage — i.e. changes never reached the DB.
// Auto-create them here (idempotently: -955 = "name already used" is ignored)
// so saving settings persists on any DB, same as the other tables above.
async function ensureSettingsTables() {
  const conn = await getConnection();
  if (!conn) return;
  try {
    await conn.execute(`
      BEGIN
        EXECUTE IMMEDIATE 'CREATE TABLE MODBUS_ADMIN.system_settings (
          setting_key   VARCHAR2(64) PRIMARY KEY,
          setting_value VARCHAR2(4000),
          setting_type  VARCHAR2(16) DEFAULT ''string'' NOT NULL,
          updated_at    TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
        )';
      EXCEPTION
        WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
      END;
    `);
    await conn.execute(`
      BEGIN
        EXECUTE IMMEDIATE 'CREATE TABLE MODBUS_ADMIN.device_settings (
          device_id     NUMBER NOT NULL,
          setting_key   VARCHAR2(64) NOT NULL,
          setting_value VARCHAR2(4000),
          setting_type  VARCHAR2(16) DEFAULT ''string'' NOT NULL,
          updated_at    TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
          CONSTRAINT pk_device_settings PRIMARY KEY (device_id, setting_key)
        )';
      EXCEPTION
        WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
      END;
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
        `MERGE INTO MODBUS_ADMIN.permissions t
           USING (SELECT :k AS permission_key FROM dual) s
           ON (t.permission_key = s.permission_key)
         WHEN NOT MATCHED THEN
           INSERT (permission_key, description, resource_type, access_level)
           VALUES (:k, :d, :r, :a)`,
        { k: p.key, d: p.description, r: p.resource, a: p.level }
      );
      newPerms += r.rowsAffected || 0;
    }

    // 2. System roles — create missing ones and grant their default permissions
    //    on first creation only (never re-grant to an existing role).
    let newRoles = 0;
    for (const role of rbac.SYSTEM_ROLES) {
      const existing = await conn.execute(
        `SELECT role_id FROM MODBUS_ADMIN.roles WHERE role_key = :rk`,
        { rk: role.key }
      );
      if (existing.rows?.length) continue; // already present — leave it alone

      const ins = await conn.execute(
        `INSERT INTO MODBUS_ADMIN.roles (role_key, role_name, description, is_system, scope_level)
         VALUES (:rk, :rn, :rd, 1, :sl)
         RETURNING role_id INTO :outId`,
        {
          rk: role.key, rn: role.name, rd: role.description, sl: role.scopeLevel,
          outId: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        }
      );
      const roleId = ins.outBinds.outId[0];
      newRoles++;

      for (const key of rbac.permissionKeysForRole(role)) {
        await conn.execute(
          `INSERT INTO MODBUS_ADMIN.role_permissions (role_id, permission_id)
           SELECT :rid, permission_id FROM MODBUS_ADMIN.permissions WHERE permission_key = :k`,
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
    const adminRes = await conn.execute(
      `SELECT role_id FROM MODBUS_ADMIN.roles WHERE role_key = 'admin'`
    );
    const adminId = adminRes.rows?.[0]?.[0];
    let adminGranted = 0;
    if (adminId) {
      const g = await conn.execute(
        `INSERT INTO MODBUS_ADMIN.role_permissions (role_id, permission_id)
         SELECT :rid, p.permission_id
           FROM MODBUS_ADMIN.permissions p
          WHERE p.permission_key IN (${keyList})
            AND NOT EXISTS (
              SELECT 1 FROM MODBUS_ADMIN.role_permissions rp
               WHERE rp.role_id = :rid AND rp.permission_id = p.permission_id
            )`,
        { rid: adminId, ...keyBinds }
      );
      adminGranted = g.rowsAffected || 0;
    }

    await conn.commit();
    console.log(`[DB] RBAC seed ready (permissions: ${newPerms} new, roles: ${newRoles} new, admin grants: +${adminGranted})`);
  } catch (e) {
    await conn.rollback().catch(() => {});
    console.warn('[DB] ensureRbacSeed warning:', e.message);
  } finally {
    await conn.close().catch(() => {});
  }
}

// ── UI element catalog (create + seed) ────────────────────────────────────
// The Permissions editor renders the granular UI elements (buttons/controls)
// from MODBUS_ADMIN.ui_element_catalog. On a DB where that table was never
// populated the editor silently falls back to a small static list, so we
// create the table (idempotently, -955 = "name already used" is ignored) and
// seed the full default catalog here. Seeding uses WHEN NOT MATCHED only, so
// elements an admin has since edited or added are left untouched.
async function ensureUiElementCatalog() {
  const conn = await getConnection();
  if (!conn) return;
  try {
    await conn.execute(`
      BEGIN
        EXECUTE IMMEDIATE 'CREATE TABLE MODBUS_ADMIN.ui_element_catalog (
          element_id VARCHAR2(60) PRIMARY KEY,
          field      VARCHAR2(40),
          label      VARCHAR2(200),
          sort_order NUMBER DEFAULT 999
        )';
      EXCEPTION
        WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
      END;
    `);
    let inserted = 0;
    for (const el of rbac.UI_ELEMENT_CATALOG) {
      const r = await conn.execute(
        `MERGE INTO MODBUS_ADMIN.ui_element_catalog t
           USING (SELECT :id AS element_id FROM dual) s
           ON (t.element_id = s.element_id)
         WHEN NOT MATCHED THEN
           INSERT (element_id, field, label, sort_order)
           VALUES (:id, :field, :label, :sortOrder)`,
        { id: el.id, field: el.field, label: el.label, sortOrder: el.sortOrder }
      );
      inserted += r.rowsAffected || 0;
    }
    await conn.commit();
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
      `DELETE FROM MODBUS_ADMIN.permissions WHERE permission_key NOT IN (${inList})`,
      binds
    );

    // 2. Upsert the built-ins back to their canonical description/resource/level.
    for (const p of rbac.BUILTIN_PERMISSIONS) {
      await conn.execute(
        `MERGE INTO MODBUS_ADMIN.permissions t
           USING (SELECT :k AS permission_key FROM dual) s
           ON (t.permission_key = s.permission_key)
         WHEN MATCHED THEN UPDATE SET description = :d, resource_type = :r, access_level = :a
         WHEN NOT MATCHED THEN
           INSERT (permission_key, description, resource_type, access_level)
           VALUES (:k, :d, :r, :a)`,
        { k: p.key, d: p.description, r: p.resource, a: p.level }
      );
    }

    // 3. Rebuild the default element mappings from scratch.
    await conn.execute(`DELETE FROM MODBUS_ADMIN.permission_ui_elements`);
    for (const m of rbac.defaultElementMappings()) {
      await conn.execute(
        `INSERT INTO MODBUS_ADMIN.permission_ui_elements (permission_key, element_id)
         VALUES (:k, :e)`,
        { k: m.permissionKey, e: m.elementId }
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
        `MERGE INTO MODBUS_ADMIN.permissions t
           USING (SELECT :k AS permission_key FROM dual) s
           ON (t.permission_key = s.permission_key)
         WHEN MATCHED THEN UPDATE SET description = :d, resource_type = :r, access_level = :a
         WHEN NOT MATCHED THEN
           INSERT (permission_key, description, resource_type, access_level)
           VALUES (:k, :d, :r, :a)`,
        { k: p.key, d: p.description, r: p.resource, a: p.level }
      );
    }

    for (const role of rbac.SYSTEM_ROLES) {
      // Ensure the system role exists (create if missing; never rename it here).
      await conn.execute(
        `MERGE INTO MODBUS_ADMIN.roles t
           USING (SELECT :rk AS role_key FROM dual) s
           ON (t.role_key = s.role_key)
         WHEN MATCHED THEN UPDATE SET is_system = 1
         WHEN NOT MATCHED THEN
           INSERT (role_key, role_name, description, is_system, scope_level)
           VALUES (:rk, :rn, :rd, 1, :sl)`,
        { rk: role.key, rn: role.name, rd: role.description, sl: role.scopeLevel }
      );

      const rr = await conn.execute(
        `SELECT role_id FROM MODBUS_ADMIN.roles WHERE role_key = :rk`,
        { rk: role.key }
      );
      const roleId = rr.rows?.[0]?.[0];
      if (!roleId) continue;

      // Reset this role's permissions to the default set.
      await conn.execute(
        `DELETE FROM MODBUS_ADMIN.role_permissions WHERE role_id = :rid`,
        { rid: roleId }
      );
      for (const key of rbac.permissionKeysForRole(role)) {
        await conn.execute(
          `INSERT INTO MODBUS_ADMIN.role_permissions (role_id, permission_id)
           SELECT :rid, permission_id FROM MODBUS_ADMIN.permissions WHERE permission_key = :k`,
          { rid: roleId, k: key }
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
  oracledb,
};
