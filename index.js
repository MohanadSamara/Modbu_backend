const express = require('express');
const readline = require('readline');

// Globals
let currentDeviceConfig = null;
let currentDeviceId = null;
let modbusClient;
let lastConnectAttemptAt = 0;
const CONNECT_RETRY_COOLDOWN_MS = 5000;

require('dotenv').config();
const { connectModbus, disconnectModbus, getSession, isConnected, getClient, stopButton, startButton, readFuel, getDeviceConfig } = require('./modbus_connect');
const { initPool, closePool, getConnection, logDeviceAction, logFuelReading, getConsumptionRate, checkFuelAlarms } = require('./db');
const { query, execute } = require('./db-helpers');
const authRoutes  = require('./routes-auth');
const userRoutes  = require('./routes-users');
const { authenticate, requirePermission, requireAnyPermission } = require('./middleware');
const cors = require('cors');
const app = express();

const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CLI Full Menu
function printMenu() {
  console.log('\n=== MODBUS MENU ===');
  console.log('1) Connect device_id');
  console.log('2) Connect IP:port');
  console.log('3) Status');
  console.log('4) Start');
  console.log('5) Stop');
  console.log('6) Fuel');
  console.log('7) Disconnect');
  console.log('8) Add device');
  console.log('9) Menu');
  console.log('0) Exit');
}

function ask(question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

async function menuConnectDevice() {
  const deviceId = parseInt(await ask('Device ID: '));
  if (!deviceId) return;
  try {
    const config = await getDeviceConfig(deviceId);
    if (config) {
      const result = await connectModbus(deviceId);
      if (result.ok) {
        modbusClient = getClient();
        currentDeviceConfig = config;
        currentDeviceId = config.device_id;
        console.log(`✅ Connected ${config.name}`);
      } else {
        console.log('Connect fail:', result.error);
      }
    }
  } catch (err) {
    console.log('Connect fail:', err.message);
  }
}

async function menuConnectManual() {
  const ip = await ask('IP: ');
  const port = parseInt(await ask('Port (502): ') || '502');
  try {
    const result = await connectModbus(null, ip, port);
    if (result.ok) {
      modbusClient = getClient();
      currentDeviceConfig = { name: 'Manual', ip, port };
      currentDeviceId = null;
      console.log(`✅ Manual ${ip}:${port}`);
    } else {
      console.log('Fail:', result.error);
    }
  } catch (err) {
    console.log('Fail:', err.message);
  }
}

function menuStatus() {
  console.log(isConnected() ? 'Connected' : 'Disconnected');
  console.log('ID:', currentDeviceId || 'N/A');
  console.log('Config:', JSON.stringify(currentDeviceConfig || null));
}

async function menuStart() {
  if (!isConnected()) return console.log('Connect first!');
  try {
    await startButton();
    if (currentDeviceId) await logDeviceAction(currentDeviceId, 'START');
    console.log('Start OK');
  } catch (err) {
    console.log('Start fail:', err.message);
  }
}

async function menuStop() {
  if (!isConnected()) return console.log('Connect first!');
  try {
    const ok = await stopButton();
    if (ok && currentDeviceId) await logDeviceAction(currentDeviceId, 'STOP');
    console.log(ok ? 'Stop OK' : 'Stop fail');
  } catch (err) {
    console.log('Stop fail:', err.message);
  }
}

async function menuFuel() {
  if (!isConnected()) return console.log('Connect first!');
  try {
    const f = await readFuel();
    console.log('Fuel:', f ? f + '%' : 'Fail');
  } catch (err) {
    console.log('Fuel fail:', err.message);
  }
}

async function menuDisconnect() {
  if (modbusClient) await modbusClient.close();
  currentDeviceConfig = currentDeviceId = null;
  console.log('Disconnected');
}

async function menuAddDevice() {
  const id = parseInt(await ask('ID: '));
  const name = await ask('Name: ');
  const ip = await ask('IP: ');
  const port = parseInt(await ask('Port: ') || '502');
  const status = await ask('Status: ') || 'online';
  const conn = await getConnection();
  if (conn) {
    try {
      await conn.execute(
`INSERT INTO MODBUS_ADMIN.devices (device_id, device_name, device_ip, device_port, status) VALUES (:device_id, :device_name, :device_ip, :device_port, :status)`,
        { device_id: id, device_name: name, device_ip: ip, device_port: port, status },
        { autoCommit: true }
      );
      console.log('Added OK');
    } catch (err) {
      console.log('Add fail:', err.message);
    } finally {
      await conn.close();
    }
  }
}

async function startCLI() {
  printMenu();
  while (true) {
    const ch = await ask('Choice: ');
    switch (ch) {
      case '1': await menuConnectDevice(); break;
      case '2': await menuConnectManual(); break;
      case '3': menuStatus(); break;
      case '4': await menuStart(); break;
      case '5': await menuStop(); break;
      case '6': await menuFuel(); break;
      case '7': await menuDisconnect(); break;
      case '8': await menuAddDevice(); break;
      case '9': printMenu(); break;
      case '0': rl.close(); return;
      default: console.log('Invalid');
    }
  }
}

// ── Auth & user-management routes ────────────────────────────────────────
// /api/auth/*  : login, logout, refresh, me, change-password (no /register —
//                user creation is admin-only via /api/users)
// /api/users/* : admin user CRUD, role assignment
// /api/roles, /api/permissions, /api/audit  (also under userRoutes)
app.use('/api/auth', authRoutes);
app.use('/api',      userRoutes);

// API
app.get('/', (_, res) => res.json({ ready: true }));

// ── Session endpoint — returns current Modbus connection state ────────────
// The frontend calls this on every Projects tab mount to restore UI state
// without triggering a new TCP connect.
app.get('/api/modbus/session', authenticate, requirePermission('device.read'), (_, res) => {
  res.json(getSession());
});

app.get('/api/registers', authenticate, requirePermission('device.read'), async (_, res) => {
  // Stub for registers - extend with real Modbus read if needed
  res.json([
    { id: '40001', name: 'Fuel Level', value: 75, type: 'holding', timestamp: new Date().toISOString() },
    { id: '40002', name: 'Temperature', value: 23.5, type: 'holding', timestamp: new Date().toISOString() },
    { id: '40003', name: 'Pressure', value: 1.2, type: 'holding', timestamp: new Date().toISOString() }
  ]);
});

app.get('/api/events', authenticate, requirePermission('alarm.read'), async (_, res) => {
  const conn = await getConnection();
  if (conn) {
    try {
const r = await conn.execute('SELECT * FROM MODBUS_ADMIN.device_actions ORDER BY action_id DESC');
      res.json(r.rows.map(row => ({id: row[0], device: row[1], type: row[2], time: row[3] || null, severity: 'info' })));
    } catch (e) {
      console.error('/api/events error:', e.message);
      res.json([]);
    } finally {
      conn.close();
    }
  } else {
    res.json([]);
  }
});

app.get('/api/stats', authenticate, requirePermission('device.read'), async (req, res) => {
  // Stub stats for charts
  const period = req.query.period || '24h';
  res.json([
    { timestamp: new Date(Date.now() - 24*60*60*1000).toISOString(), packets: 1250, errors: 5 },
    { timestamp: new Date(Date.now() - 12*60*60*1000).toISOString(), packets: 2450, errors: 2 },
    { timestamp: new Date().toISOString(), packets: 3800, errors: 1 }
  ]);
});

// Note: The /api/devices route with filters is defined below. This route handles both:
// - GET /api/devices (returns all devices)
// - GET /api/devices?location_id=X (filters by location)
// - GET /api/devices?project_id=X (filters by project)

const CHILD_TABLES = [
  'MODBUS_ADMIN.device_readings',
  'MODBUS_ADMIN.device_actions',
];

app.delete('/api/devices/:id', authenticate, requirePermission('device.write'), async (req, res) => {
  const rawId = req.params.id;
  const deviceId = Number.parseInt(rawId, 10);

  if (!Number.isInteger(deviceId) || deviceId <= 0) {
    return res.status(400).json({ error: 'Invalid device id' });
  }

  const conn = await getConnection();
  if (!conn) {
    return res.status(503).json({ error: 'DB unavailable' });
  }

  try {
    for (const table of CHILD_TABLES) {
      await conn.execute(
        `DELETE FROM ${table} WHERE device_id = :id`,
        { id: deviceId }
      );
    }

    const result = await conn.execute(
      'DELETE FROM MODBUS_ADMIN.DEVICES WHERE device_id = :id',
      { id: deviceId }
    );

    if ((result.rowsAffected || 0) === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Device not found' });
    }

    await conn.commit();
    return res.json({ success: true, deleted: deviceId });

  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }

    console.error('DELETE /api/devices/:id error:', {
      rawId,
      parsedId: deviceId,
      message: e.message
    });

    if (/ORA-02292/i.test(e.message)) {
      return res.status(409).json({
        error: 'Device has related records and cannot be deleted. ' +
               'Remove dependent rows first or enable ON DELETE CASCADE.'
      });
    }

    return res.status(500).json({ error: e.message });

  } finally {
    try { await conn.close(); } catch (_) { /* ignore */ }
  }
});




app.get('/api/device-actions', authenticate, requirePermission('alarm.read'), async (_, res) => {
  const conn = await getConnection();
  if (conn) {
    try {
const r = await conn.execute('SELECT * FROM MODBUS_ADMIN.device_actions ORDER BY action_id DESC');
      res.json(r.rows.map(row => ({id: row[0], device: row[1], type: row[2], time: row[3] || null})));
    } catch (e) {
      console.error('GET /api/device-actions error:', e.message);
      res.status(500).json({ error: e.message });
    } finally {
      conn.close();
    }
  } else {
    res.json([]);
  }
});

app.get('/api/modbus/connect', authenticate, requirePermission('device.connect'), async (req, res) => {
  const deviceId = req.query.device_id ? parseInt(req.query.device_id) : null;
  const ip = req.query.ip;
  const port = parseInt(req.query.port || 502);

  try {
    if (deviceId) {
      const config = await getDeviceConfig(deviceId);
      if (!config) {
        return res.status(404).json({ success: false, error: `Device ${deviceId} not found in database` });
      }

      const result = await connectModbus(deviceId);
      lastConnectAttemptAt = Date.now();

      if (result.ok) {
        modbusClient = getClient();
        currentDeviceConfig = config;
        currentDeviceId = deviceId;
        // Pre-warm thresholds cache so the first /fuel poll's background
        // work is just an INSERT (no SELECT for thresholds).
        getEffectiveThresholds(deviceId).catch(() => {});
        return res.json({ success: true, device: currentDeviceConfig });
      }

      return res.status(503).json({
        success: false,
        error: result.error || `Unable to connect to ${config.name || 'device'} at ${config.ip}:${config.port}`
      });
    }

    if (ip) {
      const result = await connectModbus(null, ip, port);
      lastConnectAttemptAt = Date.now();

      if (result.ok) {
        modbusClient = getClient();
        currentDeviceConfig = { name: 'Manual', ip, port };
        currentDeviceId = null;
        return res.json({ success: true, device: currentDeviceConfig });
      }

      return res.status(503).json({
        success: false,
        error: result.error || `Unable to connect to ${ip}:${port}`
      });
    }

    return res.status(400).json({
      success: false,
      error: 'Provide either device_id or ip query parameter (port defaults to 502)'
    });
  } catch (e) {
    lastConnectAttemptAt = Date.now();
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/modbus/start', authenticate, requireAnyPermission(['device.start', 'device.control']), async (_, res) => {
  if (!isConnected()) return res.status(503).json({ error: 'No connection' });
  try {
    await startButton();
    if (currentDeviceId) await logDeviceAction(currentDeviceId, 'START');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/modbus/stop', authenticate, requireAnyPermission(['device.stop', 'device.control']), async (_, res) => {
  if (!isConnected()) return res.status(503).json({ error: 'No connection' });
  try {
    const ok = await stopButton();
    if (ok && currentDeviceId) await logDeviceAction(currentDeviceId, 'STOP');
    res.json({ success: ok });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/modbus/disconnect', authenticate, requirePermission('device.connect'), async (_, res) => {
  try {
    await disconnectModbus();   // clears session + disables auto-reconnect
    modbusClient        = null;
    currentDeviceConfig = null;
    currentDeviceId     = null;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Resolve effective thresholds for a device (system defaults + per-device overrides)
// Cached per deviceId for THRESHOLDS_CACHE_MS. Thresholds change rarely (only
// when an admin edits settings), so re-running 2 SQL queries on every fuel
// poll is wasteful. Use invalidateThresholdsCache() after writes to settings.
const _thresholdsCache = new Map(); // deviceId|null -> { value, ts }
const THRESHOLDS_CACHE_MS = 60_000; // 60s

function invalidateThresholdsCache(deviceId) {
  if (deviceId === undefined) {
    _thresholdsCache.clear();
  } else {
    _thresholdsCache.delete(deviceId ?? 'null');
  }
}

async function getEffectiveThresholds(deviceId) {
  const cacheKey = deviceId ?? 'null';
  const cached   = _thresholdsCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < THRESHOLDS_CACHE_MS) {
    return cached.value;
  }

  // Start with system defaults
  const defaults = {
    lowTank:         parseFloat(SETTING_DEFAULTS.LOW_TANK_THRESHOLD.value),
    criticalTank:    parseFloat(SETTING_DEFAULTS.CRITICAL_TANK_THRESHOLD.value),
    consumptionRate: parseFloat(SETTING_DEFAULTS.CONSUMPTION_RATE_THRESHOLD.value),
    alertsEnabled:   SETTING_DEFAULTS.FUEL_ALERTS_ENABLED.value === 'true',
  };

  const conn = await getConnection();
  if (!conn) {
    _thresholdsCache.set(cacheKey, { value: defaults, ts: Date.now() });
    return defaults;
  }

  try {
    // System settings (overrides defaults)
    const sysRes = await conn.execute(
      `SELECT setting_key, setting_value, setting_type
         FROM MODBUS_ADMIN.system_settings
        WHERE setting_key IN ('LOW_TANK_THRESHOLD','CRITICAL_TANK_THRESHOLD','CONSUMPTION_RATE_THRESHOLD','FUEL_ALERTS_ENABLED')`
    );
    for (const row of sysRes.rows || []) {
      const k = row[0], v = row[1];
      if (k === 'LOW_TANK_THRESHOLD')         defaults.lowTank         = parseFloat(v);
      else if (k === 'CRITICAL_TANK_THRESHOLD')   defaults.criticalTank    = parseFloat(v);
      else if (k === 'CONSUMPTION_RATE_THRESHOLD') defaults.consumptionRate = parseFloat(v);
      else if (k === 'FUEL_ALERTS_ENABLED')       defaults.alertsEnabled   = v === 'true';
    }

    // Per-device overrides take precedence
    if (deviceId) {
      const devRes = await conn.execute(
        `SELECT setting_key, setting_value
           FROM MODBUS_ADMIN.device_settings
          WHERE device_id = :deviceId
            AND setting_key IN ('LOW_TANK_THRESHOLD','CRITICAL_TANK_THRESHOLD','CONSUMPTION_RATE_THRESHOLD','FUEL_ALERTS_ENABLED')`,
        { deviceId }
      );
      for (const row of devRes.rows || []) {
        const k = row[0], v = row[1];
        if (k === 'LOW_TANK_THRESHOLD')         defaults.lowTank         = parseFloat(v);
        else if (k === 'CRITICAL_TANK_THRESHOLD')   defaults.criticalTank    = parseFloat(v);
        else if (k === 'CONSUMPTION_RATE_THRESHOLD') defaults.consumptionRate = parseFloat(v);
        else if (k === 'FUEL_ALERTS_ENABLED')       defaults.alertsEnabled   = v === 'true';
      }
    }
  } catch (e) {
    console.warn('[Thresholds] load error, using defaults:', e.message);
  } finally {
    try { await conn.close(); } catch (_) {}
  }

  _thresholdsCache.set(cacheKey, { value: defaults, ts: Date.now() });
  return defaults;
}

// ── /api/modbus/fuel — hot path ───────────────────────────────────────────
// Goal: respond as fast as possible. Critical path is just:
//   isConnected check → readFuel() (Modbus TCP) → res.json(...)
// Everything else (DB insert, threshold lookup, alarm evaluation,
// auto-reconnect attempts) runs in the background.
//
// To keep the response shape unchanged we cache the most-recent
// alarm/consumption result per device and return that snapshot
// alongside the fresh fuel value. The background worker refreshes
// the snapshot for the next call.
const _lastAlarmInfo = new Map();   // deviceId -> { triggered, consumption, ts }
let _bgInflight = new Map();        // deviceId -> Promise (dedup background work)
let _reconnectInflight = null;      // single in-flight reconnect attempt

function _kickReconnect() {
  // Non-blocking auto-reconnect. Only one attempt at a time, throttled
  // by CONNECT_RETRY_COOLDOWN_MS so we never thrash the device.
  if (_reconnectInflight) return;
  const now = Date.now();
  if (now - lastConnectAttemptAt < CONNECT_RETRY_COOLDOWN_MS) return;
  lastConnectAttemptAt = now;

  _reconnectInflight = (async () => {
    try {
      let result;
      if (currentDeviceId) {
        result = await connectModbus(currentDeviceId);
      } else if (currentDeviceConfig?.ip) {
        result = await connectModbus(null, currentDeviceConfig.ip, currentDeviceConfig.port || 502);
      } else {
        result = await connectModbus();
      }
      if (result && result.ok) {
        modbusClient = getClient();
      }
    } catch (err) {
      console.warn('[Fuel] background reconnect failed:', err.message);
    } finally {
      _reconnectInflight = null;
    }
  })();
}

function _backgroundFuelWork(deviceId, fuelValue) {
  // Coalesce: if we're already running a background pass for this device,
  // don't queue another one — the in-flight one will pick up the new value
  // on its next iteration via the most recent log.
  if (_bgInflight.has(deviceId)) return;

  const p = (async () => {
    try {
      // Run the persist + threshold lookup in parallel — they don't
      // depend on each other. logFuelReading already deduplicates
      // unchanged readings, so most polls do zero DB work here.
      const [, thresholds] = await Promise.all([
        logFuelReading(deviceId, fuelValue),
        getEffectiveThresholds(deviceId),
      ]);

      const info = await checkFuelAlarms(deviceId, fuelValue, thresholds);
      _lastAlarmInfo.set(deviceId, {
        triggered:   info.triggered || [],
        consumption: info.consumption || null,
        ts:          Date.now(),
      });
    } catch (err) {
      console.error('[Fuel] background work error:', err.message);
    } finally {
      _bgInflight.delete(deviceId);
    }
  })();

  _bgInflight.set(deviceId, p);
}

app.get('/api/modbus/fuel', authenticate, requirePermission('fuel.read'), async (_, res) => {
  try {
    if (!isConnected()) {
      // Cold path: kick reconnect in background and return immediately.
      // (Old code awaited connectModbus inline — up to a 5 s timeout
      // blocking every disconnected request.)
      _kickReconnect();

      const target = currentDeviceConfig
        ? `${currentDeviceConfig.name || 'device'} (${currentDeviceConfig.ip}:${currentDeviceConfig.port || 502})`
        : `default device (port 502)`;

      return res.status(503).json({
        error: 'Modbus device unavailable',
        detail: `No active connection to ${target}. Verify device power/network and TCP port 502.`,
        code: 'MODBUS_UNAVAILABLE'
      });
    }

    // Hot path: only the Modbus read is awaited.
    const f = await readFuel();
    if (f === null || f === undefined) {
      return res.status(502).json({
        error: 'Fuel read failed',
        code: 'MODBUS_READ_FAILED'
      });
    }

    // Pull the most recent alarm/consumption snapshot computed by the
    // previous background pass so the response shape stays identical.
    // First call after connect will have no snapshot → empty arrays/null,
    // matching the old behaviour when no alarms were triggered.
    const snap = currentDeviceId ? _lastAlarmInfo.get(currentDeviceId) : null;

    res.json({
      fuel: f,
      consumptionRate: snap?.consumption ? snap.consumption.ratePerHour : null,
      consumption:     snap?.consumption || null,
      alarms:          snap?.triggered   || [],
    });

    // Fire-and-forget: persist + alarm check happen after response is sent.
    if (currentDeviceId) {
      _backgroundFuelWork(currentDeviceId, f);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Consumption rate endpoint ─────────────────────────────────────────────
app.get('/api/consumption-rate/:deviceId', authenticate, requirePermission('fuel.read'), async (req, res) => {
  const deviceId = parseInt(req.params.deviceId);
  if (!Number.isInteger(deviceId) || deviceId <= 0) {
    return res.status(400).json({ error: 'Invalid device ID' });
  }
  const windowMinutes = parseInt(req.query.window) || 60;
  try {
    const consumption = await getConsumptionRate(deviceId, windowMinutes);
    if (!consumption) {
      return res.json({
        deviceId,
        ratePerHour: null,
        message: 'Not enough recent readings to compute consumption rate'
      });
    }
    res.json({ deviceId, ...consumption });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Recent alarms endpoint ────────────────────────────────────────────────
app.get('/api/alarms', authenticate, requirePermission('alarm.read'), async (req, res) => {
  const deviceId = req.query.device_id ? parseInt(req.query.device_id) : null;
  const limit    = Math.min(parseInt(req.query.limit) || 50, 500);
  const conn = await getConnection();
  if (!conn) return res.json([]);
  try {
    const binds = {};
    let where = "WHERE action_type LIKE 'ALARM_%'";
    if (deviceId) {
      where += ' AND device_id = :deviceId';
      binds.deviceId = deviceId;
    }
    const sql =
      `SELECT * FROM (
         SELECT action_id, device_id, action_type, action_time
           FROM MODBUS_ADMIN.device_actions
           ${where}
         ORDER BY action_time DESC
       ) WHERE ROWNUM <= ${limit}`;
    const r = await conn.execute(sql, binds);
    res.json((r.rows || []).map(row => ({
      id:       row[0],
      deviceId: row[1],
      type:     row[2],
      time:     row[3],
      severity: row[2] === 'ALARM_CRITICAL_FUEL' ? 'critical' : 'warning',
    })));
  } catch (e) {
    console.error('GET /api/alarms error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    try { await conn.close(); } catch (_) {}
  }
});

// ============================================================================
// PROJECTS API
// ============================================================================
app.get('/api/projects', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    // Check if user has GLOBAL project.read (any role with no project_id)
    const globalRes = await query(
      `SELECT 1
         FROM MODBUS_ADMIN.user_roles       ur
         JOIN MODBUS_ADMIN.role_permissions rp ON rp.role_id      = ur.role_id
         JOIN MODBUS_ADMIN.permissions      p  ON p.permission_id = rp.permission_id
         JOIN MODBUS_ADMIN.users            u  ON u.user_id       = ur.user_id
        WHERE u.status         = 'active'
          AND ur.user_id       = :userId
          AND p.permission_key = 'project.read'
          AND ur.project_id    IS NULL
          AND ROWNUM = 1`,
      { userId }
    );
    const hasGlobal = globalRes.length > 0;

    let sql;
    let binds = {};

    if (hasGlobal) {
      // Admin / global viewer: see every project
      sql = `SELECT ID, NAME, DESCRIPTION, CREATED_AT, UPDATED_AT
               FROM MODBUS_ADMIN.projects ORDER BY ID`;
    } else {
      // Scoped-only access: only projects explicitly granted via user_roles
      sql = `SELECT ID, NAME, DESCRIPTION, CREATED_AT, UPDATED_AT
               FROM MODBUS_ADMIN.projects
              WHERE ID IN (
                    SELECT DISTINCT ur.project_id
                      FROM MODBUS_ADMIN.user_roles       ur
                      JOIN MODBUS_ADMIN.role_permissions rp ON rp.role_id      = ur.role_id
                      JOIN MODBUS_ADMIN.permissions      p  ON p.permission_id = rp.permission_id
                      JOIN MODBUS_ADMIN.users            u  ON u.user_id       = ur.user_id
                     WHERE u.status         = 'active'
                       AND ur.user_id       = :userId
                       AND p.permission_key = 'project.read'
                       AND ur.project_id    IS NOT NULL
                  )
              ORDER BY ID`;
      binds = { userId };
    }

    const result = await query(sql, binds);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects', authenticate, requirePermission('project.write'), async (req, res) => {
  const { name, description } = req.body;
  if (!name || name.trim().length === 0) return res.status(400).json({ error: 'Name required' });
  try {
    await execute(
      'INSERT INTO MODBUS_ADMIN.projects (name, description) VALUES (:name, :description)',
      { name: name.trim(), description: description || null }
    );
    res.status(201).json({ success: true });
  } catch (e) {
    if (e.message.includes('UQ_PROJECTS_NAME')) {
      res.status(409).json({ error: 'Project name must be unique' });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

app.get('/api/projects/:id', authenticate, requirePermission('project.read'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid project ID' });
  try {
    const rows = await query('SELECT id, name, description, created_at, updated_at FROM MODBUS_ADMIN.projects WHERE id = :id', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/projects/:id', authenticate, requirePermission('project.write'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid project ID' });
  const { name, description } = req.body;
  if (!name || name.trim().length === 0) return res.status(400).json({ error: 'Name required' });
  try {
    const result = await execute(
      'UPDATE MODBUS_ADMIN.projects SET name = :name, description = :description WHERE id = :id',
      { name: name.trim(), description: description || null, id }
    );
    if ((result.rowsAffected || 0) === 0) return res.status(404).json({ error: 'Project not found' });
    res.json({ success: true });
  } catch (e) {
    if (e.message.includes('UQ_PROJECTS_NAME')) {
      res.status(409).json({ error: 'Project name must be unique' });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

app.delete('/api/projects/:id', authenticate, requirePermission('project.write'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid project ID' });
  }

  const conn = await getConnection();
  if (!conn) return res.status(503).json({ error: 'DB unavailable' });

  try {
    const result = await conn.execute(
      'DELETE FROM MODBUS_ADMIN.projects WHERE id = :id',
      { id }
    );

    if ((result.rowsAffected || 0) === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Project not found' });
    }

    await conn.commit();
    return res.json({ success: true, deleted: id });
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    console.error('DELETE /api/projects/:id error:', { projectId: id, message: e.message });
    return res.status(500).json({ error: e.message });
  } finally {
    try { await conn.close(); } catch (_) {}
  }
});


// List locations for project
app.get('/api/projects/:projectId/locations', authenticate, requirePermission('project.read'), async (req, res) => {
  const projectId = parseInt(req.params.projectId);
  if (!Number.isInteger(projectId) || projectId <= 0) return res.status(400).json({ error: 'Invalid project ID' });
  try {
    // First get all locations for the project as flat list
    const rows = await query(`
      SELECT id, project_id, parent_id, name, description, address, created_at, updated_at
      FROM MODBUS_ADMIN.locations 
      WHERE project_id = :projectId
      ORDER BY name
    `, [projectId]);
    
    // If no rows, return empty array
    if (rows.length === 0) {
      return res.json([]);
    }
    
    // Debug: Log what we get from DB
    console.log('Raw rows count:', rows.length, 'first row keys:', Object.keys(rows[0]));
    
    // Process rows to ensure IDs are numbers - handle various Oracle output formats
    const items = rows.map(row => {
      const id = Number(row.ID);
      const pidStr = row.PARENT_ID;
      // Handle Oracle's various null/empty representations
      let pid = null;
      if (pidStr !== undefined && pidStr !== null && pidStr !== '') {
        pid = Number(pidStr);
      }
      return {
        ID: id,
        PROJECT_ID: Number(row.PROJECT_ID),
        PARENT_ID: pid,
        NAME: row.NAME,
        DESCRIPTION: row.DESCRIPTION,
        ADDRESS: row.ADDRESS,
        CREATED_AT: row.CREATED_AT,
        UPDATED_AT: row.UPDATED_AT
      };
    });
    
    // Debug: Log first item
    console.log('First processed item:', JSON.stringify(items[0]));
    
// Build hierarchical tree - if parent_id is null or equals its own ID (bad data), treat as top-level
    // Added depth limit and visited tracking to prevent infinite recursion
    const buildTree = (allItems, parentId = null, depth = 0, visited = new Set()) => {
      // Prevent infinite recursion - max depth of 10
      if (depth > 10) {
        console.warn('Max depth reached, stopping recursion');
        return [];
      }
      
      const children = allItems.filter(item => {
        // Skip already visited items to prevent circular reference issues
        if (visited.has(item.ID)) return false;
        
        if (parentId === null) {
          // Top-level: parent_id is null OR parent_id equals its own ID (self-referential = bad data)
          return item.PARENT_ID === null || item.PARENT_ID === item.ID;
        }
        return item.PARENT_ID === parentId;
      });
      
      return children.map(child => {
        // Mark this ID as visited before recursing
        visited.add(child.ID);
        
        return {
          id: child.ID,
          project_id: child.PROJECT_ID,
          parent_id: child.PARENT_ID,
          name: child.NAME,
          description: child.DESCRIPTION,
          address: child.ADDRESS,
          created_at: child.CREATED_AT,
          updated_at: child.UPDATED_AT,
          depth: parentId === null ? 1 : depth + 1,
          path: '/' + child.NAME,
          children: buildTree(allItems, child.ID, depth + 1, new Set(visited))
        };
      });
    };
    
    const tree = buildTree(items);
    console.log('Tree built, count:', tree.length);
    res.json(tree);
  } catch (e) {
    console.error('List locations error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// LOCATIONS API
// ============================================================================
app.post('/api/projects/:projectId/locations', authenticate, requirePermission('project.write'), async (req, res) => {
  const projectId = parseInt(req.params.projectId);
  if (!Number.isInteger(projectId) || projectId <= 0) return res.status(400).json({ error: 'Invalid project ID' });
  const { name, description, address, parent_id } = req.body;
  if (!name || name.trim().length === 0) return res.status(400).json({ error: 'Name required' });
  
  // Validate parent_id belongs to same project if provided
  if (parent_id) {
    const parent = await query('SELECT project_id FROM MODBUS_ADMIN.locations WHERE id = :id', [parent_id]);
    if (parent.length === 0) return res.status(400).json({ error: 'Parent location not found' });
    if (parent[0].PROJECT_ID != projectId) return res.status(400).json({ error: 'Parent must be in same project' });
  }
  
  try {
    if (parent_id) {
      await execute(
        'INSERT INTO MODBUS_ADMIN.locations (project_id, name, description, address, parent_id) VALUES (:projectId, :name, :description, :address, :parentId)',
        { projectId, name: name.trim(), description: description || null, address: address || null, parentId: parent_id }
      );
    } else {
      await execute(
        'INSERT INTO MODBUS_ADMIN.locations (project_id, name, description, address) VALUES (:projectId, :name, :description, :address)',
        { projectId, name: name.trim(), description: description || null, address: address || null }
      );
    }
    res.status(201).json({ success: true });
  } catch (e) {
    if (e.message.includes('UQ_LOCATIONS_PROJ_PARENT_NAME')) {
      res.status(409).json({ error: 'Location name must be unique within project/parent' });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

app.get('/api/locations/:id', authenticate, requirePermission('project.read'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid location ID' });
  try {
    const rows = await query(
      'SELECT id, project_id, parent_id, name, description, address, created_at, updated_at FROM MODBUS_ADMIN.locations WHERE id = :id',
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Location not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/locations/:id', authenticate, requirePermission('project.write'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid location ID' });
  const { name, description, address, parent_id } = req.body;
  if (!name || name.trim().length === 0) return res.status(400).json({ error: 'Name required' });
  try {
    // Validate parent_id same project if provided
    if (parent_id !== undefined) {
      const loc = await query('SELECT project_id FROM MODBUS_ADMIN.locations WHERE id = :id', [id]);
      if (loc.length === 0) return res.status(404).json({ error: 'Location not found' });
      const projectId = loc[0].PROJECT_ID;
      if (parent_id) {
        const parent = await query('SELECT project_id FROM MODBUS_ADMIN.locations WHERE id = :pid', [parent_id]);
        if (parent.length === 0) return res.status(400).json({ error: 'Parent location not found' });
        if (parent[0].PROJECT_ID != projectId) return res.status(400).json({ error: 'Parent must be in same project' });
      }
    }
    const updates = ['name = :name', 'description = :description', 'address = :address'];
    const binds = { name: name.trim(), description: description || null, address: address || null, id };
    if (parent_id !== undefined) {
      updates.push('parent_id = :parentId');
      binds.parentId = parent_id || null;
    }
    const result = await execute(
      `UPDATE MODBUS_ADMIN.locations SET ${updates.join(', ')} WHERE id = :id`,
      binds
    );
    if ((result.rowsAffected || 0) === 0) return res.status(404).json({ error: 'Location not found' });
    res.json({ success: true });
  } catch (e) {
    if (e.message.includes('UQ_LOCATIONS_PROJ_PARENT_NAME')) {
      res.status(409).json({ error: 'Location name must be unique within project/parent' });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

app.delete('/api/locations/:id', authenticate, requirePermission('project.write'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid location ID' });
  try {
    const result = await execute(
      'DELETE FROM MODBUS_ADMIN.locations WHERE id = :id',
      { id }
    );
    if ((result.rowsAffected || 0) === 0) return res.status(404).json({ error: 'Location not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Devices by location
app.get('/api/locations/:locationId/devices', authenticate, requirePermission('device.read'), async (req, res) => {
  const locationId = parseInt(req.params.locationId);
  if (!Number.isInteger(locationId) || locationId <= 0) return res.status(400).json({ error: 'Invalid location ID' });
  try {
    const rows = await query(
      'SELECT device_id as id, device_name as name, device_ip as ip, device_port as port, status, location_id FROM MODBUS_ADMIN.devices WHERE location_id = :locationId ORDER BY device_name',
      [locationId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET sub-locations
app.get('/api/locations/:id/children', authenticate, requirePermission('project.read'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid location ID' });
  try {
    const rows = await query(
      'SELECT id, project_id, parent_id, name, description, address, created_at, updated_at FROM MODBUS_ADMIN.locations WHERE parent_id = :id ORDER BY name',
      [id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Project tree view
app.get('/api/project-tree', authenticate, requirePermission('project.read'), async (req, res) => {
  try {
    const rows = await query('SELECT * FROM MODBUS_ADMIN.v_project_tree');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update /api/devices to support filters and location_id
app.get('/api/devices', authenticate, requirePermission('device.read'), async (req, res) => {
  const { location_id, project_id, status } = req.query;
  let sql = 'SELECT device_id as id, device_name as name, device_ip as ip, device_port as port, status, location_id FROM MODBUS_ADMIN.devices';
  const binds = [];
  const conditions = [];
  if (location_id) {
    conditions.push('location_id = :location_id');
    binds.push(parseInt(location_id));
  }
  if (project_id) {
    conditions.push('location_id IN (SELECT id FROM MODBUS_ADMIN.locations WHERE project_id = :project_id)');
    binds.push(parseInt(project_id));
  }
  if (status) {
    conditions.push('status = :status');
    binds.push(status);
  }
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY device_name';
  try {
    const rows = await query(sql, binds);
    res.json(rows);
  } catch (e) {
    console.error('GET /api/devices error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Update POST /api/devices to support location_id
app.post('/api/devices', authenticate, requirePermission('device.write'), async (req, res) => {
  const { id, name, ip, port, status, location_id } = req.body;
  console.log('POST devices body:', req.body);
  try {
    let device_id = parseInt(id);
    if (!device_id || isNaN(device_id)) {
      const result = await query('SELECT NVL(MAX(device_id), 0) + 1 as next_id FROM MODBUS_ADMIN.DEVICES');
      device_id = result[0].NEXT_ID;
    }
    const columns = ['device_id', 'device_name', 'device_ip', 'device_port', 'status'];
    const bindsObj = { 
      device_id, 
      device_name: name, 
      device_ip: ip, 
      device_port: parseInt(port) || 502, 
      status: status || 'online' 
    };
    if (location_id) {
      columns.push('location_id');
      bindsObj.location_id = parseInt(location_id);
    }
    const placeholders = columns.map(c => ':' + c).join(', ');
    const values = columns.map(c => `:${c}`).join(', ');
    await execute(
      `INSERT INTO MODBUS_ADMIN.DEVICES (${columns.join(', ')}) VALUES (${values})`,
      bindsObj
    );
    res.json({ success: true, device: { id: device_id, name, ip, port: parseInt(port), status: status || 'online', location_id } });
  } catch (e) {
    console.error('POST /api/devices error:', req.body, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Update PUT /api/devices/:id to support location_id
app.put('/api/devices/:id', authenticate, requirePermission('device.write'), async (req, res) => {
  const deviceId = parseInt(req.params.id);
  const { name, ip, port, status, location_id } = req.body;
  const updates = ['device_name = :name', 'device_ip = :ip', 'device_port = :port', 'status = :status'];
  const bindsObj = { name, ip, port: parseInt(port), status, id: deviceId };
  if (location_id !== undefined) {
    updates.push('location_id = :location_id');
    bindsObj.location_id = location_id ? parseInt(location_id) : null;
  }
  const setClause = updates.join(', ');
  try {
    const result = await execute(
      `UPDATE MODBUS_ADMIN.DEVICES SET ${setClause} WHERE device_id = :id`,
      bindsObj
    );
    if ((result.rowsAffected || 0) === 0) {
      res.status(404).json({ error: 'Device not found' });
    } else {
      res.json({ success: true, updated: deviceId });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update DELETE to handle location_id dependencies if needed (existing handles child tables)


// ============================================================================
// DEVICE SETTINGS API
// ============================================================================

// GET device settings by device_id
app.get('/api/device-settings/:deviceId', authenticate, requirePermission('settings.read'), async (req, res) => {
  const deviceId = parseInt(req.params.deviceId);
  if (!Number.isInteger(deviceId) || deviceId <= 0) {
    return res.status(400).json({ error: 'Invalid device ID' });
  }

  const conn = await getConnection();
  if (!conn) {
    return res.status(503).json({ error: 'DB unavailable' });
  }

  try {
    const result = await conn.execute(
      'SELECT setting_key, setting_value, setting_type FROM MODBUS_ADMIN.device_settings WHERE device_id = :deviceId',
      { deviceId }
    );

    // Convert rows to key-value object
    const settings = {};
    for (const row of result.rows) {
      const key = row[0];
      const value = row[1];
      const type = row[2];
      
      if (type === 'number') {
        settings[key] = parseFloat(value);
      } else if (type === 'boolean') {
        settings[key] = value === 'true';
      } else {
        settings[key] = value;
      }
    }

    res.json(settings);
  } catch (e) {
    console.error('GET /api/device-settings error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    try { await conn.close(); } catch (_) {}
  }
});

// PUT (update) device settings
app.put('/api/device-settings/:deviceId', authenticate, requirePermission('settings.write'), async (req, res) => {
  const deviceId = parseInt(req.params.deviceId);
  if (!Number.isInteger(deviceId) || deviceId <= 0) {
    return res.status(400).json({ error: 'Invalid device ID' });
  }

  const { settings } = req.body; // Expect { "LOW_TANK_THRESHOLD": 20, "FUEL_ALERTS_ENABLED": true }
  
  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'Settings object required' });
  }

  const conn = await getConnection();
  if (!conn) {
    return res.status(503).json({ error: 'DB unavailable' });
  }

  try {
    // Check if device exists
    const deviceCheck = await conn.execute(
      'SELECT device_id FROM MODBUS_ADMIN.devices WHERE device_id = :deviceId',
      { deviceId }
    );

    if (!deviceCheck.rows || deviceCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }

    // Upsert each setting
    for (const [key, value] of Object.entries(settings)) {
      const stringValue = String(value);
      const type = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
      
      // Try update first, then insert if not found
      const updateResult = await conn.execute(
        `UPDATE MODBUS_ADMIN.device_settings 
         SET setting_value = :value, setting_type = :type, updated_at = SYSTIMESTAMP 
         WHERE device_id = :deviceId AND setting_key = :key`,
        { value: stringValue, type, deviceId, key }
      );

      if (updateResult.rowsAffected === 0) {
        // Insert new setting
        await conn.execute(
          `INSERT INTO MODBUS_ADMIN.device_settings (device_id, setting_key, setting_value, setting_type) 
           VALUES (:deviceId, :key, :value, :type)`,
          { deviceId, key, value: stringValue, type }
        );
      }
    }

    await conn.commit();
    invalidateThresholdsCache(deviceId); // settings changed — drop cached value
    res.json({ success: true, deviceId, settings });
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    console.error('PUT /api/device-settings error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    try { await conn.close(); } catch (_) {}
  }
});

// ============================================================================
// GLOBAL/SYSTEM SETTINGS API
// ============================================================================

// Complete set of defaults — mirrors frontend defaultSettings
const SETTING_DEFAULTS = {
  // Fuel & Alarm
  LOW_TANK_THRESHOLD:       { value: '20',       type: 'number'  },
  CRITICAL_TANK_THRESHOLD:  { value: '10',       type: 'number'  },
  CONSUMPTION_RATE_THRESHOLD:{ value: '5',       type: 'number'  },
  FUEL_ALERTS_ENABLED:      { value: 'true',     type: 'boolean' },
  // Tank capacity
  TANK_CAPACITY_LITERS:     { value: '1000',     type: 'number'  },
  TANK_CAPACITY_UNIT:       { value: 'liters',   type: 'string'  },
  SHOW_TANK_AS_PERCENTAGE:  { value: 'true',     type: 'boolean' },
  // Connection
  DEFAULT_PORT:             { value: '502',      type: 'number'  },
  CONNECTION_TIMEOUT:       { value: '5000',     type: 'number'  },
  RETRY_ATTEMPTS:           { value: '3',        type: 'number'  },
  AUTO_RECONNECT:           { value: 'false',    type: 'boolean' },
  // Display
  SHOW_OFFLINE_DEVICES:     { value: 'true',     type: 'boolean' },
  DEFAULT_PROJECT_VIEW:     { value: 'expanded', type: 'string'  },
};

function castSetting(value, type) {
  if (type === 'number')  return parseFloat(value);
  if (type === 'boolean') return value === 'true';
  return value;
}

// GET global system settings
app.get('/api/settings', authenticate, requirePermission('settings.read'), async (_, res) => {
  const conn = await getConnection();
  if (!conn) {
    // No DB — return full defaults so the frontend always gets a complete object
    const fallback = {};
    for (const [k, { value, type }] of Object.entries(SETTING_DEFAULTS)) {
      fallback[k] = castSetting(value, type);
    }
    return res.json(fallback);
  }

  try {
    const result = await conn.execute(
      'SELECT setting_key, setting_value, setting_type FROM MODBUS_ADMIN.system_settings'
    );

    // Build DB map
    const dbMap = {};
    for (const row of result.rows) {
      dbMap[row[0]] = { value: row[1], type: row[2] };
    }

    // Merge: start with defaults, overlay DB values
    const settings = {};
    const toInsert = []; // keys that are missing from the DB

    for (const [key, def] of Object.entries(SETTING_DEFAULTS)) {
      if (dbMap[key] !== undefined) {
        settings[key] = castSetting(dbMap[key].value, dbMap[key].type);
      } else {
        // Use default value and schedule insert
        settings[key] = castSetting(def.value, def.type);
        toInsert.push(key);
      }
    }

    // Also include any extra keys that exist in DB but aren't in SETTING_DEFAULTS
    for (const [key, { value, type }] of Object.entries(dbMap)) {
      if (!(key in settings)) {
        settings[key] = castSetting(value, type);
      }
    }

    // Auto-insert missing defaults into DB (fire-and-forget, don't block response)
    if (toInsert.length > 0) {
      (async () => {
        const insertConn = await getConnection();
        if (!insertConn) return;
        try {
          for (const key of toInsert) {
            const def = SETTING_DEFAULTS[key];
            await insertConn.execute(
              `INSERT INTO MODBUS_ADMIN.system_settings (setting_key, setting_value, setting_type)
               VALUES (:key, :value, :type)`,
              { key, value: def.value, type: def.type }
            );
          }
          await insertConn.commit();
          console.log(`[Settings] Auto-inserted ${toInsert.length} missing default(s):`, toInsert.join(', '));
        } catch (insertErr) {
          // Could be a race condition duplicate — ignore
          try { await insertConn.rollback(); } catch (_) {}
        } finally {
          await insertConn.close().catch(() => {});
        }
      })();
    }

    res.json(settings);
  } catch (e) {
    console.error('GET /api/settings error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    try { await conn.close(); } catch (_) {}
  }
});

// PUT (update) global system settings
app.put('/api/settings', authenticate, requirePermission('settings.write'), async (req, res) => {
  const { settings } = req.body;
  
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return res.status(400).json({ error: 'Settings object required' });
  }

  const conn = await getConnection();
  if (!conn) {
    return res.status(503).json({ error: 'DB unavailable' });
  }

  try {
    // Upsert each setting
    for (const [key, value] of Object.entries(settings)) {
      const stringValue = String(value);
      // Infer type: prefer the known type from SETTING_DEFAULTS, fall back to JS typeof
      const knownType = SETTING_DEFAULTS[key]?.type;
      const type = knownType
        ?? (typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string');

      const updateResult = await conn.execute(
        `UPDATE MODBUS_ADMIN.system_settings 
         SET setting_value = :value, setting_type = :type, updated_at = SYSTIMESTAMP 
         WHERE setting_key = :key`,
        { value: stringValue, type, key }
      );

      if ((updateResult.rowsAffected || 0) === 0) {
        await conn.execute(
          `INSERT INTO MODBUS_ADMIN.system_settings (setting_key, setting_value, setting_type) 
           VALUES (:key, :value, :type)`,
          { key, value: stringValue, type }
        );
      }
    }

    await conn.commit();
    // System settings affect every device's effective thresholds.
    invalidateThresholdsCache();
    console.log(`[Settings] Saved ${Object.keys(settings).length} key(s)`);
    res.json({ success: true, settings });
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    console.error('PUT /api/settings error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    try { await conn.close(); } catch (_) {}
  }
});


// ── Startup ───────────────────────────────────────────────────────────────
(async () => {
  // Initialise the DB connection pool before accepting requests.
  // If the DB is unreachable at startup the server still starts —
  // the pool will retry automatically on first getConnection() call.
  const poolOk = await initPool();
  if (!poolOk) {
    console.warn('[Startup] DB pool not ready — server will retry on first request');
  }

  const server = app.listen(PORT, () => {
    console.log(`[Startup] Server listening on port ${PORT}`);
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────
  async function shutdown(signal) {
    console.log(`\n[Shutdown] ${signal} received — closing gracefully…`);
    server.close(async () => {
      await closePool();
      console.log('[Shutdown] Done.');
      process.exit(0);
    });
    // Force-exit after 15 s if something hangs
    setTimeout(() => { console.error('[Shutdown] Timeout — force exit'); process.exit(1); }, 15000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
})();
