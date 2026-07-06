const express = require('express');
const readline = require('readline');

// CLI-only globals: which device the interactive menu is pointed at. HTTP
// requests are per-device (addressed by ?device_id=) and never rely on these.
let currentDeviceConfig = null;
let currentDeviceId = null;
let lastConnectAttemptAt = 0;

require('dotenv').config();
const { connectModbus, disconnectModbus, closeAll, getSession, isConnected, stopButton, startButton, readFuel, readGps, getDeviceConfig } = require('./modbus_connect');

// Build a per-device target ({ deviceId | ip, port }) from request query params.
// Every read/write op is addressed to a specific device's connection so two
// users never operate on each other's device.
function targetFromReq(req) {
  const deviceId = req.query.device_id ? parseInt(req.query.device_id) : null;
  const ip = req.query.ip || null;
  const port = req.query.port ? parseInt(req.query.port) : undefined;
  return { deviceId, ip, port };
}
const oracledb = require('oracledb');
const { initPool, closePool, getConnection, logDeviceAction, logFuelReading, getConsumptionRate, checkFuelAlarms } = require('./db');
const { query, execute } = require('./db-helpers');
const authRoutes  = require('./routes-auth');
const userRoutes  = require('./routes-users');
const { authenticate, requirePermission, requireAnyPermission, optionalAuthenticate, enforceMappedPermissions } = require('./middleware');
const { visibleProjects, visibleLocationIds, filterVisibleDevices } = require('./nav-scope');
const cors = require('cors');
const app = express();

const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Data-driven authorization: enforce admin-defined permission→endpoint mappings
// on top of the built-in route guards. Runs after body parsing so it can read
// project/location/device ids from the request for scoped checks.
app.use(optionalAuthenticate, enforceMappedPermissions);

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

// The device the CLI is currently pointed at, as a hub target.
function cliTarget() {
  if (currentDeviceId) return { deviceId: currentDeviceId };
  if (currentDeviceConfig?.ip) return { ip: currentDeviceConfig.ip, port: currentDeviceConfig.port };
  return {};
}

function menuStatus() {
  console.log(isConnected(cliTarget()) ? 'Connected' : 'Disconnected');
  console.log('ID:', currentDeviceId || 'N/A');
  console.log('Config:', JSON.stringify(currentDeviceConfig || null));
}

async function menuStart() {
  if (!isConnected(cliTarget())) return console.log('Connect first!');
  try {
    await startButton(cliTarget());
    if (currentDeviceId) await logDeviceAction(currentDeviceId, 'START');
    console.log('Start OK');
  } catch (err) {
    console.log('Start fail:', err.message);
  }
}

async function menuStop() {
  if (!isConnected(cliTarget())) return console.log('Connect first!');
  try {
    const ok = await stopButton(cliTarget());
    if (ok && currentDeviceId) await logDeviceAction(currentDeviceId, 'STOP');
    console.log(ok ? 'Stop OK' : 'Stop fail');
  } catch (err) {
    console.log('Stop fail:', err.message);
  }
}

async function menuFuel() {
  if (!isConnected(cliTarget())) return console.log('Connect first!');
  try {
    const f = await readFuel(cliTarget());
    console.log('Fuel:', f ? f + '%' : 'Fail');
  } catch (err) {
    console.log('Fuel fail:', err.message);
  }
}

async function menuDisconnect() {
  await disconnectModbus(cliTarget());
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
  'MODBUS_ADMIN.device_settings',
];

app.delete('/api/devices/:deviceId', authenticate, requirePermission('device.write'), async (req, res) => {
  const rawId = req.params.deviceId;
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
        currentDeviceConfig = config;
        currentDeviceId = deviceId;
        // Mark the device online in the DB now that the TCP connect succeeded.
        setDeviceStatus(deviceId, 'online');
        // Pre-warm thresholds cache so the first /fuel poll's background
        // work is just an INSERT (no SELECT for thresholds).
        getEffectiveThresholds(deviceId).catch(() => {});
        // Fire-and-forget: read live GPS and store it so the map is up to date.
        backgroundGpsRead(deviceId);
        return res.json({ success: true, device: config });
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
        currentDeviceConfig = { name: 'Manual', ip, port };
        currentDeviceId = null;
        return res.json({ success: true, device: { name: 'Manual', ip, port } });
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

app.get('/api/modbus/start', authenticate, requireAnyPermission(['device.start', 'device.control']), async (req, res) => {
  const target = targetFromReq(req);
  if (!isConnected(target)) return res.status(503).json({ error: 'No connection' });
  try {
    const ok = await startButton(target);
    if (ok && target.deviceId) await logDeviceAction(target.deviceId, 'START');
    res.json({ success: ok });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/modbus/stop', authenticate, requireAnyPermission(['device.stop', 'device.control']), async (req, res) => {
  const target = targetFromReq(req);
  if (!isConnected(target)) return res.status(503).json({ error: 'No connection' });
  try {
    const ok = await stopButton(target);
    if (ok && target.deviceId) await logDeviceAction(target.deviceId, 'STOP');
    res.json({ success: ok });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/modbus/disconnect', authenticate, requirePermission('device.connect'), async (req, res) => {
  try {
    const target = targetFromReq(req);
    await disconnectModbus(target);   // closes only this device's hub
    // Mark the device offline in the DB now that its hub is closed.
    if (target.deviceId) setDeviceStatus(target.deviceId, 'offline');
    // Clear the CLI globals only if they pointed at the same device.
    if (target.deviceId && target.deviceId === currentDeviceId) {
      currentDeviceConfig = null;
      currentDeviceId     = null;
    }
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

app.get('/api/modbus/fuel', authenticate, requirePermission('fuel.read'), async (req, res) => {
  const target = targetFromReq(req);
  try {
    if (!isConnected(target)) {
      // Not connected to THIS device. Its hub (if any) auto-reconnects on its
      // own timer, so just report unavailable — no global reconnect here.
      return res.status(503).json({
        error: 'Modbus device unavailable',
        detail: 'No active connection to this device. Verify device power/network and TCP port 502, then reconnect.',
        code: 'MODBUS_UNAVAILABLE'
      });
    }

    // Hot path: only the Modbus read is awaited.
    const f = await readFuel(target);
    if (f === null || f === undefined) {
      return res.status(502).json({
        error: 'Fuel read failed',
        code: 'MODBUS_READ_FAILED'
      });
    }

    // Pull the most recent alarm/consumption snapshot computed by the
    // previous background pass so the response shape stays identical.
    const snap = target.deviceId ? _lastAlarmInfo.get(target.deviceId) : null;

    res.json({
      fuel: f,
      consumptionRate: snap?.consumption ? snap.consumption.ratePerHour : null,
      consumption:     snap?.consumption || null,
      alarms:          snap?.triggered   || [],
    });

    // Fire-and-forget: persist + alarm check happen after response is sent.
    if (target.deviceId) {
      _backgroundFuelWork(target.deviceId, f);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Device online/offline status ─────────────────────────────────────────────
// Flip the persisted status column so the Projects/Dashboard lists reflect the
// live connection state. Fire-and-forget: never block a connect/disconnect on it.
async function setDeviceStatus(deviceId, status) {
  if (!deviceId) return;
  try {
    // Going online also refreshes last_seen (the device is reachable right now).
    const sql = status === 'online'
      ? `UPDATE MODBUS_ADMIN.devices SET status = :status, last_seen = SYSTIMESTAMP WHERE device_id = :id`
      : `UPDATE MODBUS_ADMIN.devices SET status = :status WHERE device_id = :id`;
    await execute(sql, { status, id: parseInt(deviceId) });
    console.log(`[Status] Device ${deviceId} -> ${status}`);
  } catch (e) {
    console.warn(`[Status] update failed for device ${deviceId}:`, e.message);
  }
}

// ── GPS position ────────────────────────────────────────────────────────────
// Persist a live GPS reading onto the device row so the Dashboard map can show
// the device even when it later goes offline.
async function persistDeviceGps(deviceId, gps) {
  if (!deviceId || !gps || !gps.valid || !gps.hasFix) return;
  try {
    await execute(
      `UPDATE MODBUS_ADMIN.devices
          SET latitude = :lat, longitude = :lon, altitude = :alt, gps_updated_at = :ts
        WHERE device_id = :id`,
      { lat: gps.latitude, lon: gps.longitude, alt: gps.altitude, ts: new Date(), id: parseInt(deviceId) }
    );
    console.log(`[GPS] Stored ${gps.latitude},${gps.longitude} for device ${deviceId}`);
  } catch (e) {
    console.warn(`[GPS] persist failed for device ${deviceId}:`, e.message);
  }
}

// Fire-and-forget live GPS read used right after a device connects.
function backgroundGpsRead(deviceId) {
  if (!deviceId) return;
  (async () => {
    try {
      const gps = await readGps({ deviceId });
      if (gps) await persistDeviceGps(deviceId, gps);
    } catch (e) {
      console.warn(`[GPS] background read error for device ${deviceId}:`, e.message);
    }
  })();
}

// GET /api/modbus/gps — read the live GPS position of a connected device,
// store it, and return it. Mirrors the /fuel endpoint's target handling.
app.get('/api/modbus/gps', authenticate, requirePermission('device.read'), async (req, res) => {
  const target = targetFromReq(req);
  if (!isConnected(target)) {
    return res.status(503).json({
      error: 'Modbus device unavailable',
      detail: 'No active connection to this device. Connect it to read GPS.',
      code: 'MODBUS_UNAVAILABLE',
    });
  }
  try {
    const gps = await readGps(target);
    if (!gps) return res.status(502).json({ error: 'GPS read failed', code: 'MODBUS_READ_FAILED' });
    if (target.deviceId) await persistDeviceGps(target.deviceId, gps);
    res.json(gps);
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
    // A user sees a project when they have ANY grant that reaches it — global,
    // a project grant, or a location/device grant whose project resolves to it.
    // This lets a device/location-scoped user reach the project that contains
    // their scope (read-only navigation).
    const { global, ids } = await visibleProjects(req.user.id);

    if (global) {
      const rows = await query(
        `SELECT ID, NAME, DESCRIPTION, CREATED_AT, UPDATED_AT
           FROM MODBUS_ADMIN.projects ORDER BY ID`);
      return res.json(rows);
    }

    if (!ids || ids.size === 0) return res.json([]);

    const arr = [...ids];
    const names = arr.map((_, i) => `:p${i}`);
    const binds = {};
    arr.forEach((v, i) => { binds[`p${i}`] = v; });

    const rows = await query(
      `SELECT ID, NAME, DESCRIPTION, CREATED_AT, UPDATED_AT
         FROM MODBUS_ADMIN.projects
        WHERE ID IN (${names.join(', ')})
        ORDER BY ID`, binds);
    res.json(rows);
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
app.get('/api/projects/:projectId/locations', authenticate, async (req, res) => {
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
    
    // Scope filter: a device/location-scoped user only sees the path to (and
    // subtree of) their grant. null => full project visible; empty Set => the
    // user has no grant reaching this project.
    const visible = await visibleLocationIds(req.user.id, projectId, items);
    if (visible && visible.size === 0) {
      return res.status(403).json({ error: 'Forbidden: no access to this project', code: 'AUTH_FORBIDDEN' });
    }
    const scopedItems = visible ? items.filter(it => visible.has(it.ID)) : items;

    const tree = buildTree(scopedItems);
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
app.post('/api/projects/:projectId/locations', authenticate, requireAnyPermission(['project.write', 'location.write']), async (req, res) => {
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

app.get('/api/locations/:id', authenticate, requireAnyPermission(['project.read', 'location.read']), async (req, res) => {
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

app.put('/api/locations/:id', authenticate, requireAnyPermission(['project.write', 'location.write']), async (req, res) => {
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

app.delete('/api/locations/:id', authenticate, requireAnyPermission(['project.write', 'location.write']), async (req, res) => {
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
      `SELECT d.device_id as id, d.device_name as name, d.device_ip as ip, d.device_port as port, d.status, d.location_id, d.latitude, d.longitude, d.altitude, d.last_seen, d.brand_id, b.brand_name
         FROM MODBUS_ADMIN.devices d
         LEFT JOIN MODBUS_ADMIN.brands b ON b.brand_id = d.brand_id
        WHERE d.location_id = :locationId ORDER BY d.device_name`,
      [locationId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET sub-locations
app.get('/api/locations/:id/children', authenticate, requireAnyPermission(['project.read', 'location.read']), async (req, res) => {
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
app.get('/api/devices', authenticate, async (req, res) => {
  const { location_id, project_id, status } = req.query;
  let sql = `SELECT d.device_id as id, d.device_name as name, d.device_ip as ip, d.device_port as port, d.status, d.location_id, d.latitude, d.longitude, d.altitude, d.last_seen, d.brand_id, b.brand_name
               FROM MODBUS_ADMIN.devices d
               LEFT JOIN MODBUS_ADMIN.brands b ON b.brand_id = d.brand_id`;
  const binds = [];
  const conditions = [];
  if (location_id) {
    conditions.push('d.location_id = :location_id');
    binds.push(parseInt(location_id));
  }
  if (project_id) {
    conditions.push('d.location_id IN (SELECT id FROM MODBUS_ADMIN.locations WHERE project_id = :project_id)');
    binds.push(parseInt(project_id));
  }
  if (status) {
    conditions.push('d.status = :status');
    binds.push(status);
  }
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY d.device_name';
  try {
    const rows = await query(sql, binds);
    // Scope filter: return only devices the user can see (global sees all;
    // otherwise their granted devices + devices in projects/locations they hold).
    const visibleRows = await filterVisibleDevices(req.user.id, rows);
    res.json(visibleRows);
  } catch (e) {
    console.error('GET /api/devices error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Update POST /api/devices to support location_id
app.post('/api/devices', authenticate, requirePermission('device.write'), async (req, res) => {
  const { id, name, ip, port, status, location_id, latitude, longitude, brand_id } = req.body;
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
    if (brand_id !== undefined && brand_id !== null && brand_id !== '') {
      columns.push('brand_id');
      bindsObj.brand_id = parseInt(brand_id);
    }
    // Optional manual GPS coordinates (also auto-filled from Modbus when connected)
    if (latitude !== undefined && latitude !== null && latitude !== '' && !isNaN(parseFloat(latitude))) {
      columns.push('latitude');
      bindsObj.latitude = parseFloat(latitude);
    }
    if (longitude !== undefined && longitude !== null && longitude !== '' && !isNaN(parseFloat(longitude))) {
      columns.push('longitude');
      bindsObj.longitude = parseFloat(longitude);
    }
    if (bindsObj.latitude !== undefined || bindsObj.longitude !== undefined) {
      columns.push('gps_updated_at');
      bindsObj.gps_updated_at = new Date(); // oracledb binds JS Date to TIMESTAMP
    }
    const placeholders = columns.map(c => ':' + c).join(', ');
    const values = columns.map(c => `:${c}`).join(', ');
    await execute(
      `INSERT INTO MODBUS_ADMIN.DEVICES (${columns.join(', ')}) VALUES (${values})`,
      bindsObj
    );
    res.json({ success: true, device: { id: device_id, name, ip, port: parseInt(port), status: status || 'online', location_id, latitude: bindsObj.latitude ?? null, longitude: bindsObj.longitude ?? null } });
  } catch (e) {
    console.error('POST /api/devices error:', req.body, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Update PUT /api/devices/:id to support location_id
app.put('/api/devices/:deviceId', authenticate, requirePermission('device.write'), async (req, res) => {
  const deviceId = parseInt(req.params.deviceId);
  const { name, ip, port, status, location_id, latitude, longitude, last_seen, brand_id } = req.body;
  // Partial update: only touch the columns actually present in the request, so
  // a coordinates-only save doesn't null out (or NaN) name/ip/port/status.
  const updates = [];
  const bindsObj = { id: deviceId };

  if (name !== undefined)   { updates.push('device_name = :name'); bindsObj.name = name; }
  if (ip !== undefined)     { updates.push('device_ip = :ip');     bindsObj.ip = ip; }
  if (port !== undefined) {
    const p = parseInt(port);
    if (Number.isNaN(p)) return res.status(400).json({ error: 'Invalid port' });
    updates.push('device_port = :port'); bindsObj.port = p;
  }
  if (status !== undefined) { updates.push('status = :status'); bindsObj.status = status; }
  // Optional last_seen: accept an ISO-8601 string, or send now via SYSTIMESTAMP
  // when the client passes the literal "now".
  if (last_seen !== undefined) {
    if (last_seen === 'now' || last_seen === null) {
      updates.push('last_seen = SYSTIMESTAMP');
    } else {
      const d = new Date(last_seen);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid last_seen' });
      updates.push('last_seen = :last_seen');
      bindsObj.last_seen = d;
    }
  }
  if (location_id !== undefined) {
    updates.push('location_id = :location_id');
    bindsObj.location_id = location_id ? parseInt(location_id) : null;
  }
  // Brand assignment. Empty string / null clears it.
  if (brand_id !== undefined) {
    updates.push('brand_id = :brand_id');
    bindsObj.brand_id = (brand_id === '' || brand_id === null) ? null : parseInt(brand_id);
  }
  // Manual GPS coordinate edits. Empty string clears the coordinate.
  if (latitude !== undefined) {
    const lat = (latitude === '' || latitude === null) ? null : parseFloat(latitude);
    if (lat !== null && Number.isNaN(lat)) return res.status(400).json({ error: 'Invalid latitude' });
    updates.push('latitude = :latitude');
    bindsObj.latitude = lat;
    if (bindsObj.gps_updated_at === undefined) {
      updates.push('gps_updated_at = :gps_updated_at');
      bindsObj.gps_updated_at = new Date();
    }
  }
  if (longitude !== undefined) {
    const lon = (longitude === '' || longitude === null) ? null : parseFloat(longitude);
    if (lon !== null && Number.isNaN(lon)) return res.status(400).json({ error: 'Invalid longitude' });
    updates.push('longitude = :longitude');
    bindsObj.longitude = lon;
    if (bindsObj.gps_updated_at === undefined) {
      updates.push('gps_updated_at = :gps_updated_at');
      bindsObj.gps_updated_at = new Date();
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
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

// PATCH /api/devices/:id/last-seen — stamp LAST_SEEN = now.
// Called by the frontend right after a successful Modbus connect.
app.patch('/api/devices/:deviceId/last-seen', authenticate, requirePermission('device.write'), async (req, res) => {
  const deviceId = parseInt(req.params.deviceId);
  if (!Number.isInteger(deviceId) || deviceId <= 0) {
    return res.status(400).json({ error: 'Invalid device id' });
  }
  try {
    const result = await execute(
      `UPDATE MODBUS_ADMIN.devices SET last_seen = SYSTIMESTAMP WHERE device_id = :id`,
      { id: deviceId }
    );
    if ((result.rowsAffected || 0) === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }
    res.json({ success: true, last_seen: new Date().toISOString() });
  } catch (e) {
    console.error('PATCH /api/devices/:id/last-seen error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Update DELETE to handle location_id dependencies if needed (existing handles child tables)


// ============================================================================
// BRANDS API
// ============================================================================
// Brands are a small lookup table (id + name). Devices reference a brand via
// devices.brand_id (nullable FK, ON DELETE SET NULL). Viewing needs
// device.read; managing needs device.write.

app.get('/api/brands', authenticate, requirePermission('device.read'), async (_, res) => {
  try {
    const rows = await query(
      `SELECT b.brand_id AS id, b.brand_name AS name, b.created_at,
              (SELECT COUNT(*) FROM MODBUS_ADMIN.devices d WHERE d.brand_id = b.brand_id) AS device_count
         FROM MODBUS_ADMIN.brands b
        ORDER BY b.brand_name`
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /api/brands error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/brands', authenticate, requirePermission('device.write'), async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const result = await execute(
      `INSERT INTO MODBUS_ADMIN.brands (brand_name) VALUES (:name)
         RETURNING brand_id INTO :id`,
      { name, id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } }
    );
    res.status(201).json({ success: true, id: result.outBinds?.id?.[0] ?? null, name });
  } catch (e) {
    if (/uq_brands_name|unique constraint/i.test(e.message)) {
      return res.status(409).json({ error: 'Brand name must be unique' });
    }
    console.error('POST /api/brands error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/brands/:id', authenticate, requirePermission('device.write'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid brand id' });
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const result = await execute(
      `UPDATE MODBUS_ADMIN.brands SET brand_name = :name WHERE brand_id = :id`,
      { name, id }
    );
    if ((result.rowsAffected || 0) === 0) return res.status(404).json({ error: 'Brand not found' });
    res.json({ success: true, id, name });
  } catch (e) {
    if (/uq_brands_name|unique constraint/i.test(e.message)) {
      return res.status(409).json({ error: 'Brand name must be unique' });
    }
    console.error('PUT /api/brands/:id error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/brands/:id', authenticate, requirePermission('device.write'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid brand id' });
  try {
    // FK is ON DELETE SET NULL, so any devices using this brand keep existing
    // with brand_id cleared.
    const result = await execute(`DELETE FROM MODBUS_ADMIN.brands WHERE brand_id = :id`, { id });
    if ((result.rowsAffected || 0) === 0) return res.status(404).json({ error: 'Brand not found' });
    res.json({ success: true, deleted: id });
  } catch (e) {
    console.error('DELETE /api/brands/:id error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

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
      await closeAll().catch(() => {});   // close every Modbus device hub
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
