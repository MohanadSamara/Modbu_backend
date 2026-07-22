const express = require('express');
const readline = require('readline');

// CLI-only globals: which device the interactive menu is pointed at. HTTP
// requests are per-device (addressed by ?device_id=) and never rely on these.
let currentDeviceConfig = null;
let currentDeviceId = null;
let lastConnectAttemptAt = 0;

// Device alarm snooze timestamps: { deviceId → snooze_until_ms }
// Shared across all users/browsers so multiple users on the same device respect
// each other's alarm accepts. This Map is a write-through cache in front of the
// device_snoozes table — it is seeded from the DB at startup (loadSnoozes) and
// every write also persists, so snoozes now survive a server restart.
const deviceSnoozes = new Map();

require('dotenv').config();
// device-io is a thin facade over modbus_connect (direct TCP) + remote-hub
// (reverse tunnel to site agents). Same function surface — a device is served
// over the tunnel when an agent for it is connected, else via direct TCP.
const { connectModbus, disconnectModbus, closeAll, getSession, isConnected, stopButton, startButton, readFuel, readGps, readRegisters, readTelemetry, getDeviceConfig } = require('./device-io');
const remoteHub = require('./remote-hub');
const telemetryWs = require('./telemetry-ws');
const { bucketEvents } = require('./lib/telemetry-math');
// Per-brand read-only data sources (e.g. Datakom Rainbow over WebSocket). Modbus
// brands don't use this — they're read via device-io. See brand-adapters.js.
const brandAdapters = require('./brand-adapters');

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
const { initPool, closePool, getConnection, logDeviceAction, logFuelReading, getConsumptionRate, getFuelHistory, getEventTimes, checkFuelAlarms, ensureAlarmsTable, getActiveAlarms, acknowledgeAlarm, ensureSnoozeTable, getActiveSnoozes, setSnooze, ensureDatakomNodeNamesTable, getDatakomNodeNames, setDatakomNodeName, ensureDatakomNodeContainersTable, getDatakomNodeContainers, setDatakomNodeContainer, ensureProjectParentColumn, projectParentWouldCycle, ensurePageContentTable, getPageContent, savePageContent, ensureSettingsTables, ensureRbacSeed, ensureUiElementCatalog } = require('./db');
const { query, execute } = require('./db-helpers');
const authRoutes  = require('./routes-auth');
const userRoutes  = require('./routes-users');
const { authenticate, requirePermission, requireAnyPermission, requirePermissionIfBodyPresent, optionalAuthenticate, enforceMappedPermissions } = require('./middleware');
const { visibleProjects, visibleLocationIds, filterVisibleDevices } = require('./nav-scope');
const cors = require('cors');
const app = express();

// Support --port <n> passed via CLI (e.g. npm run dev -- --port 5400)
const _cliArgs = process.argv.slice(2);
const _portArgIdx = _cliArgs.indexOf('--port');
const PORT = (_portArgIdx !== -1 ? parseInt(_cliArgs[_portArgIdx + 1], 10) : null)
          || parseInt(process.env.PORT, 10)
          || 3000;

const _allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000')
  .split(',').map(o => o.trim()).filter(Boolean);
app.use(cors({ origin: _allowedOrigins }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static('public'));

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
  const status = await ask('Status: ') || 'offline';
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
// Unauthenticated health probe — the frontend header pill polls this to show
// live backend reachability. Must be registered BEFORE the /api routers,
// whose router-level authenticate would otherwise 401 it. Exposes nothing
// beyond liveness.
app.get('/api/health', (_, res) => res.json({ ok: true, uptime: Math.floor(process.uptime()) }));

app.use('/api/auth', authRoutes);
app.use('/api',      userRoutes);

// API
// The root path intentionally has no route: when deploy/www exists it serves
// the hosted frontend (see the block near the bottom of this file); health
// probes use /api/health above.

// ── Session endpoint — returns current Modbus connection state ────────────
// The frontend calls this on every Projects tab mount to restore UI state
// without triggering a new TCP connect.
app.get('/api/modbus/session', authenticate, requirePermission('device.read'), (_, res) => {
  const session = getSession();

  // Inject Datakom Rainbow connections into the devices list so the health
  // dashboard's "Device Connections" section shows them alongside Modbus devices.
  const dkAdapter = brandAdapters.getAdapter('datakom');
  if (dkAdapter?.isReady?.()) {
    // Only a CONNECTED Modbus entry suppresses the cloud injection (local Modbus
    // wins when it's actually up). A disconnected/failed Modbus entry — e.g. left
    // behind by a Connect attempt that timed out because we're off the device's
    // LAN — must NOT block the cloud path, or clicking Connect would knock the
    // device offline instead of falling back to Datakom.
    const connectedIds = new Set(
      session.devices
        .filter((d) => d.connected && d.deviceId != null)
        .map((d) => Number(d.deviceId))
    );
    for (const [devId, did] of _deviceIdToDid) {
      if (connectedIds.has(devId)) continue;
      const r = dkAdapter.getReading(did);
      if (r?.reading) {
        session.devices.push({
          connected: true,
          deviceId:  devId,
          method:    'datakom-rainbow',
          did,
          readAt:    r.reading.readAt,
        });
        connectedIds.add(devId);
      }
    }
    if (!session.connected && session.devices.some((d) => d.connected)) {
      session.connected = true;
    }
  }

  res.json(session);
});

// Real register snapshot for a connected device. Replaces the old hardcoded
// stub: reads live fuel + GPS off the device and returns them in the
// register-list shape the frontend expects. Requires ?device_id= (or ?ip=)
// and an active connection, mirroring /api/modbus/fuel.
app.get('/api/registers', authenticate, requirePermission('device.read'), async (req, res) => {
  const target = targetFromReq(req);
  if (!isConnected(target)) {
    return res.status(503).json({
      error: 'Modbus device unavailable',
      detail: 'No active connection to this device. Connect it to read registers.',
      code: 'MODBUS_UNAVAILABLE',
    });
  }
  try {
    const t = await readTelemetry(target);
    if (!t) return res.status(502).json({ error: 'Register read failed', code: 'MODBUS_READ_FAILED' });
    const ts = t.readAt || new Date().toISOString();
    // Engine/analog block + RPM + battery (manual p.13), then GPS (p.14).
    const registers = [
      { id: '10361', name: 'Oil Pressure',    value: t.oilPressure,    unit: 'bar', type: 'holding', timestamp: ts },
      { id: '10362', name: 'Engine Temp',     value: t.engineTemp,     unit: '°C',  type: 'holding', timestamp: ts },
      { id: '10363', name: 'Fuel Level',      value: t.fuel,           unit: '%',   type: 'holding', timestamp: ts },
      { id: '10364', name: 'Oil Temp',        value: t.oilTemp,        unit: '°C',  type: 'holding', timestamp: ts },
      { id: '10365', name: 'Canopy Temp',     value: t.canopyTemp,     unit: '°C',  type: 'holding', timestamp: ts },
      { id: '10366', name: 'Ambient Temp',    value: t.ambientTemp,    unit: '°C',  type: 'holding', timestamp: ts },
      { id: '10376', name: 'Engine RPM',      value: t.rpm,            unit: 'rpm', type: 'holding', timestamp: ts },
      { id: '10385', name: 'Battery Voltage', value: t.batteryVoltage, unit: 'V',   type: 'holding', timestamp: ts },
    ];
    if (t.gps) {
      registers.push(
        { id: '10594', name: 'Latitude',  value: t.gps.latitude,  unit: '°', type: 'holding', timestamp: ts },
        { id: '10596', name: 'Longitude', value: t.gps.longitude, unit: '°', type: 'holding', timestamp: ts },
        { id: '10598', name: 'Altitude',  value: t.gps.altitude,  unit: 'm', type: 'holding', timestamp: ts },
      );
    }
    res.json(registers);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// Real activity stats for charts. Buckets device_readings ("packets") and
// ALARM_* device_actions ("errors") over the requested period. Replaces the
// old hardcoded three-point stub.
//   ?period=1h|6h|24h|7d|30d   ?device_id=<n> (optional scope to one device)
const STATS_PERIODS = {
  '1h':  { spanMs: 60 * 60_000,            buckets: 12 },
  '6h':  { spanMs: 6 * 60 * 60_000,        buckets: 12 },
  '24h': { spanMs: 24 * 60 * 60_000,       buckets: 24 },
  '7d':  { spanMs: 7 * 24 * 60 * 60_000,   buckets: 14 },
  '30d': { spanMs: 30 * 24 * 60 * 60_000,  buckets: 30 },
};

app.get('/api/stats', authenticate, requirePermission('device.read'), async (req, res) => {
  const period = STATS_PERIODS[req.query.period] ? req.query.period : '24h';
  const { spanMs, buckets } = STATS_PERIODS[period];
  const deviceId = req.query.device_id ? parseInt(req.query.device_id) : null;
  try {
    const windowMinutes = Math.ceil(spanMs / 60_000);
    const { readings, alarms } = await getEventTimes(windowMinutes, deviceId);
    const now = Date.now();
    const events = [
      ...readings.map((t) => ({ t, kind: 'packet' })),
      ...alarms.map((t) => ({ t, kind: 'error' })),
    ];
    const series = bucketEvents(events, { now, spanMs, buckets, errorKind: 'error' })
      .map((b) => ({ timestamp: b.timestamp, packets: b.total - b.errors, errors: b.errors }));
    res.json(series);
  } catch (e) {
    console.error('GET /api/stats error:', e.message);
    res.status(500).json({ error: e.message });
  }
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
    cooldownMinutes: parseFloat(SETTING_DEFAULTS.ALARM_COOLDOWN_MINUTES.value),
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
        WHERE setting_key IN ('LOW_TANK_THRESHOLD','CRITICAL_TANK_THRESHOLD','CONSUMPTION_RATE_THRESHOLD','FUEL_ALERTS_ENABLED','ALARM_COOLDOWN_MINUTES')`
    );
    for (const row of sysRes.rows || []) {
      const k = row[0], v = row[1];
      if (k === 'LOW_TANK_THRESHOLD')         defaults.lowTank         = parseFloat(v);
      else if (k === 'CRITICAL_TANK_THRESHOLD')   defaults.criticalTank    = parseFloat(v);
      else if (k === 'CONSUMPTION_RATE_THRESHOLD') defaults.consumptionRate = parseFloat(v);
      else if (k === 'FUEL_ALERTS_ENABLED')       defaults.alertsEnabled   = v === 'true';
      else if (k === 'ALARM_COOLDOWN_MINUTES')    defaults.cooldownMinutes = parseFloat(v);
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
        else if (k === 'ALARM_COOLDOWN_MINUTES')    defaults.cooldownMinutes = parseFloat(v);
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
  // No usable reading (sensor unavailable / sentinel decoded to null). Skip so
  // we neither persist a bogus sample nor evaluate alarms against a non-value.
  if (typeof fuelValue !== 'number' || !Number.isFinite(fuelValue)) return;

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

      const info = await checkFuelAlarms(deviceId, fuelValue, thresholds, {
        cooldownMinutes: thresholds.cooldownMinutes,
      });
      _lastAlarmInfo.set(deviceId, {
        triggered:   info.triggered || [],
        consumption: info.consumption || null,
        ts:          Date.now(),
      });
      // Push the refreshed alarm/consumption snapshot to live subscribers.
      telemetryWs.broadcastTelemetry(deviceId, {
        fuel:            fuelValue,
        consumptionRate: info.consumption ? info.consumption.ratePerHour : null,
        consumption:     info.consumption || null,
        alarms:          info.triggered   || [],
        at:              new Date().toISOString(),
      });
    } catch (err) {
      console.error('[Fuel] background work error:', err.message);
    } finally {
      _bgInflight.delete(deviceId);
    }
  })();

  _bgInflight.set(deviceId, p);
}

// ── Live telemetry poll loop ───────────────────────────────────────────────
// Continuously reads every connected device and pushes fresh fuel/consumption/
// alarm frames to WebSocket subscribers, so browsers get live updates WITHOUT
// polling REST. One read serves every viewer. It self-gates two ways to avoid
// needless Modbus traffic:
//   • skips entirely when no browser is listening (clientCount === 0)
//   • never overlaps a slow tick with the next (_telemetryPolling guard)
// _backgroundFuelWork() does the logging, threshold/alarm evaluation and the
// broadcast — the same path the /api/modbus/fuel route uses — so live-pushed
// data is identical to a REST read.
const TELEMETRY_POLL_MS = Math.max(1000, Number(process.env.TELEMETRY_POLL_MS) || 2000);
let _telemetryPolling = false;

async function telemetryPollTick() {
  if (_telemetryPolling) return;                 // previous tick still running
  if (telemetryWs.clientCount() === 0) return;   // nobody listening
  _telemetryPolling = true;
  try {
    const connected = getSession().devices.filter((d) => d.connected && d.deviceId != null);
    await Promise.all(
      connected.map(async (d) => {
        const deviceId = Number(d.deviceId);
        try {
          const f = await readFuel({ deviceId });
          if (typeof f === 'number' && Number.isFinite(f)) {
            _backgroundFuelWork(deviceId, f);    // logs, evaluates alarms, broadcasts
          } else {
            // No usable reading — mirror the "unavailable" state so live clients
            // agree with what a REST read would have returned.
            telemetryWs.broadcastTelemetry(deviceId, {
              fuel: null, reading: 'unavailable', alarms: [], at: new Date().toISOString(),
            });
          }
        } catch (_) {
          // Transient read error — the hub flips itself to disconnected and
          // schedules a reconnect. Nothing to push this tick.
        }
      })
    );
  } finally {
    _telemetryPolling = false;
  }
}

app.get('/api/modbus/fuel', authenticate, requirePermission('fuel.read'), async (req, res) => {
  const target = targetFromReq(req);
  try {
    if (!isConnected(target)) {
      // Not connected to THIS device over Modbus/IP. If it is also linked to a
      // Datakom cloud device, fail over to the live cloud reading so a dual-homed
      // device keeps serving fuel from whichever source is up.
      const dk = target.deviceId ? datakomFuelForDevice(target.deviceId) : null;
      if (dk) return _sendCloudFuel(res, target.deviceId, dk);
      // Its hub (if any) auto-reconnects on its own timer, so just report
      // unavailable — no global reconnect here.
      return res.status(503).json({
        error: 'Modbus device unavailable',
        detail: 'No active connection to this device. Verify device power/network and TCP port 502, then reconnect.',
        code: 'MODBUS_UNAVAILABLE'
      });
    }

    // Hot path: only the Modbus read is awaited.
    const f = await readFuel(target);
    if (f === null || f === undefined) {
      // A null reading covers two very different situations:
      //   • the read threw (socket dropped) — readFuel flips the hub to
      //     disconnected and schedules a reconnect. Report a transient 502 so
      //     the client keeps its last value and retries.
      //   • the device is still connected but the tank sensor has no usable
      //     value (e.g. the 0x7FFF "unavailable" sentinel). That is a steady,
      //     expected state — not an error. Return 200 with fuel:null so the UI
      //     shows a calm "No reading" instead of a red error every few seconds.
      if (!isConnected(target)) {
        // Socket dropped mid-read. Fail over to the Datakom cloud reading if this
        // device is also linked to one, so the value survives a Modbus blip.
        const dk = target.deviceId ? datakomFuelForDevice(target.deviceId) : null;
        if (dk) return _sendCloudFuel(res, target.deviceId, dk);
        return res.status(502).json({
          error: 'Fuel read failed',
          code: 'MODBUS_READ_FAILED'
        });
      }
      const noSnap = target.deviceId ? _lastAlarmInfo.get(target.deviceId) : null;
      res.json({
        fuel:            null,
        reading:         'unavailable',
        consumptionRate: null,
        consumption:     noSnap?.consumption || null,
        alarms:          [],
      });
      // Mirror the no-reading state to live subscribers so WS clients agree.
      if (target.deviceId) {
        telemetryWs.broadcastTelemetry(target.deviceId, {
          fuel: null, reading: 'unavailable', alarms: [], at: new Date().toISOString(),
        });
      }
      return;
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

    // Push the fresh fuel value to live subscribers immediately (alarms follow
    // from the background pass below).
    if (target.deviceId) {
      telemetryWs.broadcastTelemetry(target.deviceId, {
        fuel:            f,
        consumptionRate: snap?.consumption ? snap.consumption.ratePerHour : null,
        consumption:     snap?.consumption || null,
        alarms:          snap?.triggered   || [],
        at:              new Date().toISOString(),
      });
    }

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

// ── Live status reconciliation ───────────────────────────────────────────────
// The persisted `status` column is only written 'online' on a successful connect
// and 'offline' on an *explicit* user disconnect. It is NOT updated when a socket
// silently drops, when an agent tunnel closes, or across a server restart — and
// new devices default to 'online' — so a stored 'online' is often stale.
//
// The authoritative "connected right now" signal is the live hub/agent registry
// (getSession, covering both direct-TCP and remote-agent devices). Reconcile
// every device list against it before returning:
//   • connected right now              → 'online'
//   • stored 'online' but no live link  → 'offline'  (stale write)
//   • stored 'offline' / 'shutdown'     → left unchanged

// Cache: platform device_id → Datakom did. Built at startup and refreshed after
// any device create/update, so the session merge and connectedDeviceIds() can
// resolve Rainbow connections to platform IDs without a synchronous DB query.
// Keyed by device_id (NOT did) on purpose: two platform devices can be linked to
// the SAME did, and a did→device map would collapse them so only one ever shows
// the cloud connection. It also lets a device that carries BOTH an IP and a
// datakom_did resolve its linked cloud reading, so the Modbus/IP and Datakom
// cloud sources can serve it interchangeably (failover).
const _deviceIdToDid = new Map();
async function refreshDidMap() {
  try {
    // query() resolves to the rows array itself (not a {rows} wrapper).
    const rows = await query(
      `SELECT device_id, datakom_did FROM MODBUS_ADMIN.devices WHERE datakom_did IS NOT NULL`
    );
    _deviceIdToDid.clear();
    for (const r of (rows || [])) {
      const did   = Number(r.DATAKOM_DID  ?? r.datakom_did);
      const devId = Number(r.DEVICE_ID    ?? r.device_id);
      if (Number.isFinite(did) && Number.isFinite(devId)) {
        _deviceIdToDid.set(devId, did);
      }
    }
  } catch (_) { /* non-fatal — map keeps its last good values */ }
}

// Live Datakom Rainbow fuel reading for a platform device linked to a cloud
// device (datakom_did). Returns { fuel, readAt } when the cloud has a fresh,
// percentage-scaled reading, else null. Used as the failover source on
// /api/modbus/fuel so a device configured with both an IP and a Datakom link
// keeps serving fuel from the cloud whenever its Modbus/IP connection is down
// (and from Modbus whenever that is up).
function datakomFuelForDevice(deviceId) {
  const did = _deviceIdToDid.get(Number(deviceId));
  if (did == null) return null;
  const dkAdapter = brandAdapters.getAdapter('datakom');
  if (!dkAdapter?.isReady?.()) return null;
  const r = dkAdapter.getReading(did);
  const reading = r && r.reading;
  if (!reading) return null;
  const fm = reading.metrics ? reading.metrics.fuelLevel : null;
  // Only trust a percentage-scaled fuel value (matches the gauges' %-scale),
  // mirroring datakom-rainbow.summarizeDevice().
  const fuel = fm && fm.value != null && (fm.unit == null || /%/.test(String(fm.unit)))
    ? fm.value : null;
  if (fuel == null) return null;
  return { fuel, readAt: reading.readAt || null };
}

// Send a fuel response sourced from the Datakom cloud (used when Modbus/IP is
// unavailable for a dual-homed device). Mirrors the shape of the Modbus fuel
// response, tagged with source:'datakom', and pushes the value to live
// subscribers so WS clients agree. Alarm/consumption come from the last snapshot.
function _sendCloudFuel(res, deviceId, dk) {
  const snap = deviceId ? _lastAlarmInfo.get(deviceId) : null;
  const payload = {
    fuel:            dk.fuel,
    consumptionRate: snap?.consumption ? snap.consumption.ratePerHour : null,
    consumption:     snap?.consumption || null,
    alarms:          snap?.triggered   || [],
    source:          'datakom',
    readAt:          dk.readAt,
  };
  res.json(payload);
  if (deviceId) {
    telemetryWs.broadcastTelemetry(deviceId, {
      fuel:            dk.fuel,
      consumptionRate: payload.consumptionRate,
      consumption:     payload.consumption,
      alarms:          payload.alarms,
      source:          'datakom',
      at:              dk.readAt || new Date().toISOString(),
    });
  }
}

function connectedDeviceIds() {
  const ids = new Set();
  try {
    for (const d of getSession().devices) {
      if (d.connected && d.deviceId != null) ids.add(Number(d.deviceId));
    }
  } catch { /* session not ready — treat as nothing connected */ }
  // Also count devices live via Datakom Rainbow as connected. Every platform
  // device linked to a live did is included — including multiple devices sharing
  // one did — so a dual-homed device shows online whenever its cloud side is up.
  const dkAdapter = brandAdapters.getAdapter('datakom');
  if (dkAdapter?.isReady?.()) {
    const liveDids = new Set(Array.from(dkAdapter.connectedDids(), Number));
    for (const [devId, did] of _deviceIdToDid) {
      if (liveDids.has(Number(did))) ids.add(devId);
    }
  }
  return ids;
}

function effectiveStatus(deviceId, stored, connectedIds) {
  if (connectedIds.has(Number(deviceId))) return 'online';
  const s = String(stored ?? 'offline').toLowerCase();
  return s === 'online' ? 'offline' : s;
}

// Rewrite the STATUS field of query() row objects in place (Oracle upper-cases
// unaliased columns, so the key is STATUS; tolerate a lowercase `status` too).
function reconcileDeviceRows(rows) {
  const connectedIds = connectedDeviceIds();
  for (const r of rows) {
    const id  = r.ID ?? r.id;
    const eff = effectiveStatus(id, r.STATUS ?? r.status, connectedIds);
    if ('STATUS' in r) r.STATUS = eff; else r.status = eff;
  }
  return rows;
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

// ── Combined telemetry snapshot ───────────────────────────────────────────
// One call returns live fuel + GPS + the most-recent alarm/consumption snapshot
// for a connected device. Cheaper than calling /fuel and /gps separately.
app.get('/api/modbus/telemetry', authenticate, requirePermission('device.read'), async (req, res) => {
  const target = targetFromReq(req);
  if (!isConnected(target)) {
    return res.status(503).json({
      error: 'Modbus device unavailable',
      detail: 'No active connection to this device.',
      code: 'MODBUS_UNAVAILABLE',
    });
  }
  try {
    const t = await readTelemetry(target);
    if (!t) return res.status(502).json({ error: 'Telemetry read failed', code: 'MODBUS_READ_FAILED' });

    // Persist GPS so the map stays fresh (same as /gps), fire-and-forget.
    if (target.deviceId && t.gps) persistDeviceGps(target.deviceId, t.gps);

    const snap = target.deviceId ? _lastAlarmInfo.get(target.deviceId) : null;
    // Engine/analog fields decoded from the shared register map.
    const engine = {
      oilPressure:    t.oilPressure    ?? null,
      engineTemp:     t.engineTemp     ?? null,
      oilTemp:        t.oilTemp        ?? null,
      canopyTemp:     t.canopyTemp     ?? null,
      ambientTemp:    t.ambientTemp    ?? null,
      rpm:            t.rpm            ?? null,
      batteryVoltage: t.batteryVoltage ?? null,
    };
    const payload = {
      deviceId:        target.deviceId ?? null,
      fuel:            t.fuel,
      ...engine,
      gps:             t.gps,
      consumptionRate: snap?.consumption ? snap.consumption.ratePerHour : null,
      consumption:     snap?.consumption || null,
      alarms:          snap?.triggered   || [],
      readAt:          t.readAt,
    };
    res.json(payload);

    // Push the full engine+GPS snapshot to live WebSocket subscribers.
    if (target.deviceId) {
      telemetryWs.broadcastTelemetry(target.deviceId, {
        fuel: t.fuel, ...engine, gps: t.gps, at: t.readAt,
      });
      // Feed the same background pipeline as /fuel (persist + alarm eval + push).
      _backgroundFuelWork(target.deviceId, t.fuel);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Raw holding-register read (Modbus function 3) ─────────────────────────
// Engineer tool: read any register block off a connected device.
//   GET /api/modbus/registers/read?device_id=1&start=10363&count=1
app.get('/api/modbus/registers/read', authenticate, requirePermission('device.read'), async (req, res) => {
  const target = targetFromReq(req);
  const start  = parseInt(req.query.start);
  const count  = req.query.count ? parseInt(req.query.count) : 1;
  if (!Number.isInteger(start) || start < 0) {
    return res.status(400).json({ error: 'Provide a valid start register (?start=)' });
  }
  if (!Number.isInteger(count) || count < 1 || count > 125) {
    return res.status(400).json({ error: 'count must be between 1 and 125' });
  }
  if (!isConnected(target)) {
    return res.status(503).json({
      error: 'Modbus device unavailable',
      detail: 'No active connection to this device.',
      code: 'MODBUS_UNAVAILABLE',
    });
  }
  try {
    const result = await readRegisters(target, start, count);
    if (!result) return res.status(502).json({ error: 'Register read failed', code: 'MODBUS_READ_FAILED' });
    res.json({ ...result, readAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Fuel history (for charts) ─────────────────────────────────────────────
// Returns raw FUEL samples for a device over the last ?window minutes (default
// 24h), oldest first, capped by ?limit (default 500). Reads from device_readings
// — no live Modbus connection required.
app.get('/api/fuel-history/:deviceId', authenticate, requirePermission('fuel.read'), async (req, res) => {
  const deviceId = parseInt(req.params.deviceId);
  if (!Number.isInteger(deviceId) || deviceId <= 0) {
    return res.status(400).json({ error: 'Invalid device ID' });
  }
  const windowMinutes = Math.max(1, Math.min(parseInt(req.query.window) || 1440, 43_200)); // ≤ 30d
  const limit         = parseInt(req.query.limit) || 500;
  try {
    const history = await getFuelHistory(deviceId, windowMinutes, limit);
    res.json({ deviceId, windowMinutes, count: history.length, history });
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
// Reads the dedicated MODBUS_ADMIN.alarms table (every triggered alarm is saved
// there), returning only UN-acknowledged rows. A row disappears as soon as the
// user accepts it (POST /api/alarms/:id/acknowledge). Because checkFuelAlarms
// uses a 5-min cooldown, a new alarm row appears after that cooldown if the
// device is still in an alarm condition — giving the "temporary dismiss" behaviour.
app.get('/api/alarms', authenticate, requirePermission('alarm.read'), async (req, res) => {
  const deviceId = req.query.device_id ? parseInt(req.query.device_id) : null;
  const limit    = Math.min(parseInt(req.query.limit) || 50, 500);
  try {
    const rows = await getActiveAlarms({ deviceId, limit });
    res.json(rows);
  } catch (e) {
    console.error('GET /api/alarms error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Acknowledge a specific alarm ─────────────────────────────────────────
// Marks the alarm row acknowledged in MODBUS_ADMIN.alarms so GET /api/alarms
// hides it. Idempotent: acknowledging the same alarm twice is a no-op.
// A NEW alarm row appears if checkFuelAlarms fires again for the same device
// after the cooldown period (currently 5 min).
app.post('/api/alarms/:id/acknowledge', authenticate, requirePermission('alarm.read'), async (req, res) => {
  const alarmId = parseInt(req.params.id);
  if (!Number.isInteger(alarmId) || alarmId <= 0) {
    return res.status(400).json({ error: 'Invalid alarm ID' });
  }
  try {
    const result = await acknowledgeAlarm(alarmId, req.user?.id ?? null);
    if (result.error === 'DB unavailable') return res.status(503).json({ error: 'DB unavailable' });
    if (!result.found) return res.status(404).json({ error: 'Alarm not found' });
    res.json({ success: true, id: alarmId, deviceId: result.deviceId });
  } catch (e) {
    console.error('POST /api/alarms/:id/acknowledge error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Device alarm snooze ────────────────────────────────────────────────────
// When a user accepts an alarm on any page, ALL users on that device should stop
// hearing the sound. These endpoints maintain a shared snooze timestamp per device.
//
// GET /api/devices/:deviceId/snooze
//   → Returns { snoozeUntilMs: <timestamp> | null }
//
// PUT /api/devices/:deviceId/snooze
//   → Body: { snoozeUntilMs: <timestamp> }
//   → Stores the snooze so all users on the device respect it

app.get('/api/devices/:deviceId/snooze', authenticate, requirePermission('alarm.read'), (req, res) => {
  const deviceId = parseInt(req.params.deviceId);
  if (!Number.isInteger(deviceId) || deviceId <= 0) {
    return res.status(400).json({ error: 'Invalid device ID' });
  }
  const snoozeUntilMs = deviceSnoozes.get(deviceId) || null;
  res.json({ deviceId, snoozeUntilMs });
});

app.put('/api/devices/:deviceId/snooze', authenticate, requirePermission('alarm.read'), (req, res) => {
  const deviceId = parseInt(req.params.deviceId);
  const { snoozeUntilMs } = req.body || {};
  
  if (!Number.isInteger(deviceId) || deviceId <= 0) {
    return res.status(400).json({ error: 'Invalid device ID' });
  }
  if (typeof snoozeUntilMs !== 'number' || snoozeUntilMs < 0) {
    return res.status(400).json({ error: 'Invalid snoozeUntilMs' });
  }
  
  // Store the snooze for this device (shared across all users/browsers).
  // Write-through: update the in-memory cache immediately, then persist so the
  // snooze survives a server restart. DB write is best-effort — a DB blip must
  // not break the live "stop the alarm sound" behaviour.
  if (snoozeUntilMs > 0) {
    deviceSnoozes.set(deviceId, snoozeUntilMs);
  } else {
    deviceSnoozes.delete(deviceId);
  }
  setSnooze(deviceId, snoozeUntilMs, req.user?.id ?? null).catch((e) =>
    console.warn(`[Snooze] persist failed for device ${deviceId}:`, e.message)
  );

  res.json({ success: true, deviceId, snoozeUntilMs });
});

// ── Live alarms endpoints ─────────────────────────────────────────────────
// Source: in-memory _lastAlarmInfo snapshot updated by the fuel polling loop.
// An alarm entry is "live" when it was computed within LIVE_ALARM_TTL_MS.
//
// GET /api/alarms/live
//   → Summary list for dashboard cards. Returns one entry per device that
//     currently has at least one active alarm. No DB round-trip for alarm
//     data — only a single device-name lookup query.
//
// GET /api/alarms/live/:deviceId
//   → Full detail for one device: device info, all triggered alarms with
//     fuel/threshold/rate values, consumption snapshot, and last-10 history.
const LIVE_ALARM_TTL_MS = 5 * 60_000; // treat snapshot as live for 5 min

app.get('/api/alarms/live', authenticate, requirePermission('alarm.read'), async (req, res) => {
  const now = Date.now();

  // Collect devices with non-stale, non-empty alarm snapshots
  const active = [];
  for (const [deviceId, snap] of _lastAlarmInfo) {
    if (!snap.triggered || snap.triggered.length === 0) continue;
    if (now - snap.ts > LIVE_ALARM_TTL_MS) continue;
    active.push({ deviceId, snap });
  }

  if (active.length === 0) return res.json([]);

  // Single batch query for device names / location ids
  const conn = await getConnection();
  const nameMap = {};
  if (conn) {
    try {
      const ids = active.map(a => a.deviceId);
      const binds = {};
      const placeholders = ids.map((id, i) => { binds[`d${i}`] = id; return `:d${i}`; });
      const r = await conn.execute(
        `SELECT device_id, device_name, location_id
           FROM MODBUS_ADMIN.devices
          WHERE device_id IN (${placeholders.join(', ')})`,
        binds
      );
      for (const row of r.rows || []) nameMap[row[0]] = { name: row[1], locationId: row[2] };
    } catch (_) {}
    finally { await conn.close().catch(() => {}); }
  }

  // Scope filter — only return devices visible to this user
  const visibleRows = await filterVisibleDevices(
    req.user.id,
    active.map(({ deviceId }) => ({ id: deviceId }))
  ).catch(() => active.map(({ deviceId }) => ({ id: deviceId })));
  const visibleIds = new Set(visibleRows.map(r => r.id));

  const result = active
    .filter(({ deviceId }) => visibleIds.has(deviceId))
    .map(({ deviceId, snap }) => {
      const dev      = nameMap[deviceId] || {};
      const severity = snap.triggered.some(a => a.severity === 'critical') ? 'critical' : 'warning';
      return {
        deviceId,
        deviceName: dev.name       || `Device ${deviceId}`,
        locationId: dev.locationId || null,
        severity,
        alarmCount: snap.triggered.length,
        // Compact alarm list — just enough for a card badge
        alarms: snap.triggered.map(a => ({
          type:     a.type,
          severity: a.severity || (a.type === 'ALARM_CRITICAL_FUEL' ? 'critical' : 'warning'),
          message:  a.message,
          time:     a.time,
        })),
        checkedAt: new Date(snap.ts).toISOString(),
      };
    });

  res.json(result);
});

app.get('/api/alarms/live/:deviceId', authenticate, requirePermission('alarm.read'), async (req, res) => {
  const deviceId = parseInt(req.params.deviceId);
  if (!deviceId) return res.status(400).json({ error: 'Invalid deviceId' });

  // Scope check — user must have visibility over this device
  const visible = await filterVisibleDevices(req.user.id, [{ id: deviceId }]).catch(() => []);
  if (!visible.length) return res.status(403).json({ error: 'Access denied' });

  const snap = _lastAlarmInfo.get(deviceId);
  const now  = Date.now();
  const isLive = !!(snap && snap.triggered && snap.triggered.length > 0 &&
                    (now - snap.ts) <= LIVE_ALARM_TTL_MS);

  const conn = await getConnection();
  if (!conn) return res.status(503).json({ error: 'DB unavailable' });

  try {
    // Device + location + project info in one query
    const devR = await conn.execute(
      `SELECT d.device_id, d.device_name, d.device_ip, d.device_port, d.status,
              l.name AS location_name, p.name AS project_name
         FROM MODBUS_ADMIN.devices d
         LEFT JOIN MODBUS_ADMIN.locations l ON l.id        = d.location_id
         LEFT JOIN MODBUS_ADMIN.projects  p ON p.id        = l.project_id
        WHERE d.device_id = :deviceId`,
      { deviceId }
    );
    const dev = (devR.rows || [])[0];
    if (!dev) return res.status(404).json({ error: 'Device not found' });

    // Last 10 alarm history rows from DB
    const histR = await conn.execute(
      `SELECT * FROM (
         SELECT action_id, action_type, action_time
           FROM MODBUS_ADMIN.device_actions
          WHERE device_id = :deviceId AND action_type LIKE 'ALARM_%'
         ORDER BY action_time DESC
       ) WHERE ROWNUM <= 10`,
      { deviceId }
    );
    const recentHistory = (histR.rows || []).map(row => ({
      id:       row[0],
      type:     row[1],
      time:     row[2],
      severity: row[1] === 'ALARM_CRITICAL_FUEL'    ? 'critical' : 'warning',
      message:  row[1] === 'ALARM_CRITICAL_FUEL'    ? 'Fuel critically low'
               : row[1] === 'ALARM_LOW_FUEL'         ? 'Fuel low'
               : row[1] === 'ALARM_HIGH_CONSUMPTION' ? 'High consumption rate'
               : row[1],
    }));

    res.json({
      deviceId,
      deviceName:   dev[1],
      ip:           dev[2],
      port:         dev[3],
      status:       effectiveStatus(dev[0], dev[4], connectedDeviceIds()),
      locationName: dev[5] || null,
      projectName:  dev[6] || null,
      live: {
        active:    isLive,
        checkedAt: snap ? new Date(snap.ts).toISOString() : null,
        // Full alarm detail — includes fuel%, threshold, consumption rate
        alarms: isLive ? snap.triggered.map(a => ({
          type:      a.type,
          severity:  a.severity || (a.type === 'ALARM_CRITICAL_FUEL' ? 'critical' : 'warning'),
          message:   a.message,
          time:      a.time,
          fuel:      a.fuel      ?? null,
          threshold: a.threshold ?? null,
          rate:      a.rate      ?? null,
          samples:   a.samples   ?? null,
        })) : [],
        consumption: snap?.consumption || null,
      },
      recentHistory,
    });
  } catch (e) {
    console.error('GET /api/alarms/live/:deviceId error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    await conn.close().catch(() => {});
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

    // BRAND_ID / METHOD carry the project's connection profile (see POST below):
    // METHOD is 'cloud' (Datakom Rainbow) or 'ip' (Modbus TCP) and drives the
    // default connection type of devices created under the project. BRAND_NAME is
    // joined in so the frontend can badge the project without a second lookup.
    if (global) {
      const rows = await query(
        `SELECT p.ID, p.NAME, p.DESCRIPTION, p.CREATED_AT, p.UPDATED_AT,
                p.BRAND_ID, p.METHOD, p.PARENT_ID, b.brand_name AS BRAND_NAME
           FROM MODBUS_ADMIN.projects p
           LEFT JOIN MODBUS_ADMIN.brands b ON b.brand_id = p.brand_id
          ORDER BY p.ID`);
      return res.json(rows);
    }

    if (!ids || ids.size === 0) return res.json([]);

    const arr = [...ids];
    const names = arr.map((_, i) => `:p${i}`);
    const binds = {};
    arr.forEach((v, i) => { binds[`p${i}`] = v; });

    const rows = await query(
      `SELECT p.ID, p.NAME, p.DESCRIPTION, p.CREATED_AT, p.UPDATED_AT,
              p.BRAND_ID, p.METHOD, p.PARENT_ID, b.brand_name AS BRAND_NAME
         FROM MODBUS_ADMIN.projects p
         LEFT JOIN MODBUS_ADMIN.brands b ON b.brand_id = p.brand_id
        WHERE p.ID IN (${names.join(', ')})
        ORDER BY p.ID`, binds);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects', authenticate, requirePermission('project.write'), async (req, res) => {
  const { name, description, brand_id, method, parent_id } = req.body;
  if (!name || name.trim().length === 0) return res.status(400).json({ error: 'Name required' });
  // Optional container: parent_id nests this project inside another.
  const parentId = (parent_id === '' || parent_id === null || parent_id === undefined) ? null : parseInt(parent_id);
  // A project carries a brand + a connection METHOD ('cloud' = Datakom Rainbow,
  // 'ip' = Modbus TCP). The method drives the default connection type of devices
  // created under the project. If the caller doesn't send an explicit method, it
  // is derived from the brand: a "Datakom" brand starts in cloud method, every
  // other brand in ip method.
  const bId = (brand_id === '' || brand_id === null || brand_id === undefined) ? null : parseInt(brand_id);
  let resolvedMethod = (method === 'cloud' || method === 'ip') ? method : null;
  try {
    if (!resolvedMethod && bId != null) {
      const brows = await query('SELECT brand_name FROM MODBUS_ADMIN.brands WHERE brand_id = :id', [bId]);
      const bname = String(brows[0]?.BRAND_NAME ?? brows[0]?.brand_name ?? '');
      // Match both "Datakom" (real name) and the "Datacom" spelling → cloud.
      resolvedMethod = /data[ck]om/i.test(bname) ? 'cloud' : 'ip';
    }
    resolvedMethod = resolvedMethod || 'ip';
    await execute(
      'INSERT INTO MODBUS_ADMIN.projects (name, description, brand_id, method, parent_id) VALUES (:name, :description, :brand_id, :method, :parent_id)',
      { name: name.trim(), description: description || null, brand_id: bId, method: resolvedMethod, parent_id: parentId }
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
    const rows = await query(
      `SELECT p.id, p.name, p.description, p.created_at, p.updated_at,
              p.brand_id, p.method, b.brand_name
         FROM MODBUS_ADMIN.projects p
         LEFT JOIN MODBUS_ADMIN.brands b ON b.brand_id = p.brand_id
        WHERE p.id = :id`, [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/projects/:id', authenticate, requirePermission('project.write'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid project ID' });
  const { name, description, brand_id, method, parent_id } = req.body;
  if (!name || name.trim().length === 0) return res.status(400).json({ error: 'Name required' });
  try {
    // Name/description always update. brand_id and method are optional — only
    // touched when the caller sends them, so a plain rename never wipes them.
    const sets = ['name = :name', 'description = :description'];
    const binds = { name: name.trim(), description: description || null, id };
    if (brand_id !== undefined) {
      sets.push('brand_id = :brand_id');
      binds.brand_id = (brand_id === '' || brand_id === null) ? null : parseInt(brand_id);
    }
    if (method === 'cloud' || method === 'ip') {
      sets.push('method = :method');
      binds.method = method;
    }
    // Container move: parent_id nests this project under another. Reject a move
    // that would create a cycle (a project inside itself or its own descendant).
    if (parent_id !== undefined) {
      const parentId = (parent_id === '' || parent_id === null) ? null : parseInt(parent_id);
      if (parentId != null && await projectParentWouldCycle(id, parentId)) {
        return res.status(400).json({ error: 'A project cannot be placed inside itself or its own sub-project' });
      }
      sets.push('parent_id = :parent_id');
      binds.parent_id = parentId;
    }
    const result = await execute(
      `UPDATE MODBUS_ADMIN.projects SET ${sets.join(', ')} WHERE id = :id`,
      binds
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
    // If this project is a container, promote its child projects to top-level
    // (parent_id = NULL) rather than orphaning them at a dangling parent.
    await conn.execute(
      'UPDATE MODBUS_ADMIN.projects SET parent_id = NULL WHERE parent_id = :id',
      { id }
    );
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
      `SELECT d.device_id as id, d.device_name as name, d.device_ip as ip, d.device_port as port, d.status, d.location_id, d.latitude, d.longitude, d.altitude, d.last_seen, d.brand_id, d.datakom_did, b.brand_name
         FROM MODBUS_ADMIN.devices d
         LEFT JOIN MODBUS_ADMIN.brands b ON b.brand_id = d.brand_id
        WHERE d.location_id = :locationId ORDER BY d.device_name`,
      [locationId]
    );
    res.json(reconcileDeviceRows(rows));
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
  let sql = `SELECT d.device_id as id, d.device_name as name, d.device_ip as ip, d.device_port as port, d.status, d.location_id, d.latitude, d.longitude, d.altitude, d.last_seen, d.brand_id, d.datakom_did, b.brand_name
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
    res.json(reconcileDeviceRows(visibleRows));
  } catch (e) {
    console.error('GET /api/devices error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Update POST /api/devices to support location_id
app.post('/api/devices', authenticate, requirePermission('device.write'), requirePermissionIfBodyPresent('datakom_did', 'datakom.write'), async (req, res) => {
  const { id, name, ip, port, status, location_id, latitude, longitude, brand_id, datakom_did } = req.body;
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
      // A freshly-added device has never been connected — it is offline until a
      // connect succeeds (which flips it to 'online' via setDeviceStatus).
      status: status || 'offline'
    };
    if (location_id) {
      columns.push('location_id');
      bindsObj.location_id = parseInt(location_id);
    }
    if (brand_id !== undefined && brand_id !== null && brand_id !== '') {
      columns.push('brand_id');
      bindsObj.brand_id = parseInt(brand_id);
    }
    // Link to a Datakom Rainbow device (did) — only for brand=Datakom devices.
    if (datakom_did !== undefined && datakom_did !== null && datakom_did !== '' && !isNaN(parseInt(datakom_did))) {
      columns.push('datakom_did');
      bindsObj.datakom_did = parseInt(datakom_did);
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
    if (bindsObj.datakom_did != null) refreshDidMap().catch(() => {});
    res.json({ success: true, device: { id: device_id, name, ip, port: parseInt(port), status: status || 'offline', location_id, latitude: bindsObj.latitude ?? null, longitude: bindsObj.longitude ?? null } });
  } catch (e) {
    console.error('POST /api/devices error:', req.body, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Update PUT /api/devices/:id to support location_id
app.put('/api/devices/:deviceId', authenticate, requirePermission('device.write'), requirePermissionIfBodyPresent('datakom_did', 'datakom.write'), async (req, res) => {
  const deviceId = parseInt(req.params.deviceId);
  const { name, ip, port, status, location_id, latitude, longitude, last_seen, brand_id, datakom_did } = req.body;
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
  // Datakom device link (did). Empty string / null clears it.
  if (datakom_did !== undefined) {
    updates.push('datakom_did = :datakom_did');
    bindsObj.datakom_did = (datakom_did === '' || datakom_did === null) ? null : parseInt(datakom_did);
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
      if (datakom_did !== undefined) refreshDidMap().catch(() => {});
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
// BRAND DATA SOURCES  (read-only)
// ============================================================================
// A few brands expose live values through their own portal rather than Modbus
// (e.g. Datakom Rainbow over WebSocket — see datakom-rainbow.js). These routes
// surface that per-brand adapter's cached data. `:brand` is the brand NAME
// (case-insensitive), matching brands.brand_name. Data is read-only; the only
// write path is the scaffolded control route at the bottom (inert until an
// adapter implements sendControl with a real command frame).

// Connection + session diagnostics. Also returns the last raw frames the adapter
// received, which is what you use to finalize an undocumented protocol's mapping.
app.get('/api/brands/:brand/status', authenticate, requireAnyPermission(['device.read', 'datakom.read']), (req, res) => {
  const adapter = brandAdapters.getAdapter(req.params.brand);
  if (!adapter) return res.status(404).json({ error: `No data-source adapter for brand '${req.params.brand}'` });
  res.json(adapter.getStatus());
});

// Devices the brand's portal exposes, each with its latest cached reading.
app.get('/api/brands/:brand/devices', authenticate, requireAnyPermission(['device.read', 'datakom.read']), (req, res) => {
  const adapter = brandAdapters.getAdapter(req.params.brand);
  if (!adapter) return res.status(404).json({ error: `No data-source adapter for brand '${req.params.brand}'` });
  if (!adapter.isReady?.()) {
    return res.status(503).json({ error: `Brand '${req.params.brand}' data source not connected yet`, status: adapter.getStatus() });
  }
  res.json(adapter.listDevices());
});

// One device's latest reading. `:id` may be the brand's device id or its name.
// fuel.read is accepted too: the Fuel pages read cloud fuel through this route,
// and a fuel-only user must not see empty gauges for cloud-linked devices.
app.get('/api/brands/:brand/device/:id', authenticate, requireAnyPermission(['device.read', 'datakom.read', 'fuel.read']), (req, res) => {
  const adapter = brandAdapters.getAdapter(req.params.brand);
  if (!adapter) return res.status(404).json({ error: `No data-source adapter for brand '${req.params.brand}'` });
  const data = adapter.getReading(req.params.id);
  if (!data || (!data.device && !data.reading)) {
    return res.status(404).json({ error: `Device '${req.params.id}' not found for brand '${req.params.brand}'` });
  }
  res.json(data);
});

// The brand's node hierarchy (nodes → devices), nested — a read-only project
// tree. Only adapters that expose getTree() support this (Datakom does); others
// 404 so the frontend can fall back gracefully.
app.get('/api/brands/:brand/tree', authenticate, requireAnyPermission(['device.read', 'datakom.read']), (req, res) => {
  const adapter = brandAdapters.getAdapter(req.params.brand);
  if (!adapter) return res.status(404).json({ error: `No data-source adapter for brand '${req.params.brand}'` });
  if (typeof adapter.getTree !== 'function') {
    return res.status(404).json({ error: `Brand '${req.params.brand}' does not expose a device tree` });
  }
  if (!adapter.isReady?.()) {
    return res.status(503).json({ error: `Brand '${req.params.brand}' data source not connected yet`, status: adapter.getStatus() });
  }
  res.json(adapter.getTree());
});

// ── Datakom node name overrides ─────────────────────────────────────────────
// The cloud node names are read-only on Datakom's side, so we let users store a
// local display name per node (keyed by the frontend node id, e.g. dk-node-12).
// Read is open to anyone who can see the tree; write requires datakom.write.
app.get('/api/brands/datakom/node-names', authenticate, requireAnyPermission(['device.read', 'datakom.read', 'fuel.read']), async (_req, res) => {
  try {
    res.json(await getDatakomNodeNames());
  } catch (e) {
    console.error('GET /api/brands/datakom/node-names error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/brands/datakom/node-names/:nodeId', authenticate, requirePermission('datakom.write'), async (req, res) => {
  const nodeId = String(req.params.nodeId || '').trim();
  if (!nodeId) return res.status(400).json({ error: 'Missing node id' });
  const name = (req.body?.name ?? '').toString();
  if (name.length > 200) return res.status(400).json({ error: 'Name too long (max 200)' });
  try {
    const ok = await setDatakomNodeName(nodeId, name, req.user?.id ?? null);
    if (!ok) return res.status(500).json({ error: 'Failed to save node name' });
    res.json({ success: true, nodeId, name: name.trim() || null });
  } catch (e) {
    console.error('PUT /api/brands/datakom/node-names error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Datakom node containers (local grouping) ────────────────────────────────
// Group cloud nodes into local container folders. Read is open to tree viewers;
// write (assign/clear a node's container) requires datakom.write.
app.get('/api/brands/datakom/node-containers', authenticate, requireAnyPermission(['device.read', 'datakom.read', 'fuel.read']), async (_req, res) => {
  try {
    res.json(await getDatakomNodeContainers());
  } catch (e) {
    console.error('GET /api/brands/datakom/node-containers error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/brands/datakom/node-containers/:nodeId', authenticate, requirePermission('datakom.write'), async (req, res) => {
  const nodeId = String(req.params.nodeId || '').trim();
  if (!nodeId) return res.status(400).json({ error: 'Missing node id' });
  const container = (req.body?.container ?? '').toString();
  if (container.length > 200) return res.status(400).json({ error: 'Container name too long (max 200)' });
  try {
    const ok = await setDatakomNodeContainer(nodeId, container, req.user?.id ?? null);
    if (!ok) return res.status(500).json({ error: 'Failed to save container' });
    res.json({ success: true, nodeId, container: container.trim() || null });
  } catch (e) {
    console.error('PUT /api/brands/datakom/node-containers error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Brand cloud control (start/stop) — SCAFFOLD ─────────────────────────────
// Most brand adapters are read-only and omit sendControl → 501. Datakom's adapter
// wires this end-to-end but stays INERT until the Rainbow command frame is known
// (see buildControlFrame in datakom-rainbow.js), so no guessed frame is ever sent.
// `:id` is the brand's device id (did); optional ?device_id=<platform id> logs the
// action against the platform device for Run History. Permission gates mirror the
// Modbus /api/modbus/start|stop routes exactly.
function brandControlHandler(action) {
  return async (req, res) => {
    const { brand, id } = req.params;
    const adapter = brandAdapters.getAdapter(brand);
    if (!adapter) return res.status(404).json({ error: `No data-source adapter for brand '${brand}'` });
    if (typeof adapter.sendControl !== 'function') {
      return res.status(501).json({ error: `Brand '${brand}' does not support cloud control` });
    }
    try {
      const result = await adapter.sendControl(id, action);
      if (!result.ok) {
        const status =
          result.code === 'CONTROL_NOT_CONFIGURED' ? 501 :
          result.code === 'NOT_CONNECTED'          ? 503 :
          result.code === 'UNKNOWN_DEVICE'         ? 404 : 400;
        return res.status(status).json({ error: result.error, code: result.code });
      }
      // Best-effort action log against the platform device, if the caller passed one.
      const deviceId = parseInt(req.query.device_id);
      if (Number.isInteger(deviceId)) logDeviceAction(deviceId, action.toUpperCase()).catch(() => {});
      res.json({ success: true, ...result });
    } catch (e) {
      console.error(`POST /api/brands/${brand}/device/${id}/${action} error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  };
}

app.post('/api/brands/:brand/device/:id/start', authenticate,
  requireAnyPermission(['device.start', 'device.control']), brandControlHandler('start'));

app.post('/api/brands/:brand/device/:id/stop', authenticate,
  requireAnyPermission(['device.stop', 'device.control']), brandControlHandler('stop'));

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
  ALARM_COOLDOWN_MINUTES:   { value: '60',       type: 'number'  },
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

// ============================================================================
// PAGE CONTENT API (admin visual page editor)
// ============================================================================
// Stores the frontend's <Editable> overrides so an admin's design edits are
// global. READ is available to every authenticated user (the overrides must
// render for everyone); WRITE is gated to settings.write (admins).

// GET current page-content overrides — returns {} when none set.
app.get('/api/page-content', authenticate, async (_, res) => {
  try {
    const overrides = await getPageContent();
    res.json(overrides);
  } catch (e) {
    console.error('GET /api/page-content error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PUT (replace) page-content overrides. Body: { overrides: { ... } }.
app.put('/api/page-content', authenticate, requirePermission('settings.write'), async (req, res) => {
  const { overrides } = req.body;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return res.status(400).json({ error: 'overrides object required' });
  }
  try {
    const ok = await savePageContent(overrides, req.user?.id ?? null);
    if (!ok) return res.status(500).json({ error: 'Failed to save page content' });
    console.log(`[PageContent] Saved ${Object.keys(overrides).length} override(s)`);
    res.json({ success: true, overrides });
  } catch (e) {
    console.error('PUT /api/page-content error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── Startup ───────────────────────────────────────────────────────────────
// Auto-creates the alarm_acknowledgments table and its sequence if they don't
// exist yet (safe to call on every startup — uses WHEN OTHERS THEN IF ... END).
// Also ensures ACTION_TYPE column is wide enough for all alarm type strings.
async function ensureAckTable() {
  const conn = await getConnection();
  if (!conn) return;
  try {
    // Widen ACTION_TYPE so ALARM_HIGH_CONSUMPTION (22 chars) fits.
    // MODIFY is a no-op if the column is already wide enough.
    try {
      await conn.execute(
        `ALTER TABLE MODBUS_ADMIN.device_actions MODIFY (ACTION_TYPE VARCHAR2(50))`
      );
      console.log('[DB] device_actions.ACTION_TYPE widened to VARCHAR2(50)');
    } catch (e) {
      // ORA-01442 = column is already that size or wider — safe to ignore
      if (!/ORA-01442|ORA-01451/i.test(e.message)) {
        console.warn('[DB] Could not widen ACTION_TYPE:', e.message);
      }
    }
    // Link column: which Datakom Rainbow device (did) a device maps to. Nullable;
    // only set for brand=Datakom devices. ORA-01430 = column already exists.
    try {
      await conn.execute(`ALTER TABLE MODBUS_ADMIN.devices ADD (DATAKOM_DID NUMBER)`);
      console.log('[DB] devices.DATAKOM_DID column added');
    } catch (e) {
      if (!/ORA-01430/i.test(e.message)) console.warn('[DB] Could not add DATAKOM_DID:', e.message);
    }
    // Project connection profile: BRAND_ID (which brand the project is for) and
    // METHOD ('cloud' = Datakom Rainbow, 'ip' = Modbus TCP). Added idempotently so
    // existing DBs upgrade on the next startup — this is what makes the projects
    // API (GET /api/projects joins p.brand_id) work. Each column is added on its
    // own so a partially-migrated DB still fills the gap. ORA-01430 = already exists.
    for (const col of ['BRAND_ID NUMBER', `METHOD VARCHAR2(10) DEFAULT 'ip'`]) {
      try {
        await conn.execute(`ALTER TABLE MODBUS_ADMIN.projects ADD (${col})`);
        console.log(`[DB] projects column added: ${col}`);
      } catch (e) {
        if (!/ORA-01430/i.test(e.message)) console.warn(`[DB] Could not add projects.${col}:`, e.message);
      }
    }
    // Sequence for ack_id
    await conn.execute(`
      BEGIN
        EXECUTE IMMEDIATE 'CREATE SEQUENCE MODBUS_ADMIN.alarm_ack_seq START WITH 1 INCREMENT BY 1 NOCACHE';
      EXCEPTION
        WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
      END;
    `);
    // Table
    await conn.execute(`
      BEGIN
        EXECUTE IMMEDIATE 'CREATE TABLE MODBUS_ADMIN.alarm_acknowledgments (
          ack_id          NUMBER PRIMARY KEY,
          action_id       NUMBER NOT NULL,
          device_id       NUMBER NOT NULL,
          acknowledged_by NUMBER,
          acknowledged_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
          CONSTRAINT fk_ack_device FOREIGN KEY (device_id)
            REFERENCES MODBUS_ADMIN.devices(device_id) ON DELETE CASCADE
        )';
      EXCEPTION
        WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
      END;
    `);
    // Index for fast lookups on action_id
    await conn.execute(`
      BEGIN
        EXECUTE IMMEDIATE 'CREATE INDEX MODBUS_ADMIN.ix_ack_action ON MODBUS_ADMIN.alarm_acknowledgments(action_id)';
      EXCEPTION
        WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
      END;
    `);
    console.log('[DB] alarm_acknowledgments table ready');
  } catch (e) {
    console.warn('[DB] ensureAckTable warning:', e.message);
  } finally {
    await conn.close().catch(() => {});
  }
}

// ── Hosted frontend ─────────────────────────────────────────────────────────
// Serve the built React app from deploy/www so one port (one tunnel/domain)
// carries the whole product: `npm run build` in the frontend repo, then copy
// dist/* into deploy/www. When that folder is absent (normal development —
// frontend runs on Vite :5173) this block is a no-op.
{
  const path = require('path');
  const fs = require('fs');
  const FRONTEND_DIR = process.env.FRONTEND_DIR || path.join(__dirname, 'deploy', 'www');
  const FRONTEND_INDEX = path.join(FRONTEND_DIR, 'index.html');
  if (fs.existsSync(FRONTEND_INDEX)) {
    app.use(express.static(FRONTEND_DIR));
    // SPA fallback: any unknown non-API GET renders the app shell so client-
    // side routes (/fuel-levels, /alarms, …) survive a refresh. Registered
    // after every API route, so real endpoints always win.
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      if (req.path.startsWith('/api/') || req.path.startsWith('/ws/') || req.path === '/agent-tunnel') return next();
      res.sendFile(FRONTEND_INDEX);
    });
    console.log(`[Startup] Serving frontend from ${FRONTEND_DIR}`);
  }
}

(async () => {
  // Initialise the DB connection pool before accepting requests.
  // If the DB is unreachable at startup the server still starts —
  // the pool will retry automatically on first getConnection() call.
  const poolOk = await initPool();
  if (!poolOk) {
    console.warn('[Startup] DB pool not ready — server will retry on first request');
  } else {
    // Auto-create the alarm_acknowledgments table + sequence if they don't exist.
    await ensureAckTable();
    // Auto-create the dedicated alarms table + sequence (source of truth for
    // the Active Alarms panel) if they don't exist yet.
    await ensureAlarmsTable();
    // Auto-create the device_snoozes table, then seed the in-memory cache so
    // snoozes set before the last restart are still honoured.
    await ensureSnoozeTable();
    // Custom names for Datakom cloud nodes (renamed locally, cloud untouched).
    await ensureDatakomNodeNamesTable();
    // Local grouping of Datakom cloud nodes into container folders.
    await ensureDatakomNodeContainersTable();
    // Allow a project to live inside another (container/folder nesting).
    await ensureProjectParentColumn();
    // Auto-create the page_content table backing the admin visual page editor.
    await ensurePageContentTable();
    // Auto-create the system_settings + device_settings tables so the Settings
    // page persists to the DB (they used to live in the now-removed schema.sql).
    await ensureSettingsTables();
    // Seed the built-in permissions + system roles (admin/viewer/operator) so a
    // fresh DB comes up fully populated. Idempotent + non-destructive.
    await ensureRbacSeed();
    // Auto-create + seed the ui_element_catalog so the Permissions editor shows
    // the full catalog of UI elements instead of the small static fallback.
    await ensureUiElementCatalog();
    try {
      const snoozes = await getActiveSnoozes();
      for (const [deviceId, until] of snoozes) deviceSnoozes.set(deviceId, until);
      if (snoozes.size > 0) console.log(`[Startup] Loaded ${snoozes.size} active snooze(s) from DB`);
    } catch (e) {
      console.warn('[Startup] Could not load snoozes:', e.message);
    }
    // Seed the did→device_id cache so Rainbow connections resolve immediately.
    await refreshDidMap();
  }

  const server = app.listen(PORT, () => {
    console.log(`[Startup] Server listening on port ${PORT}`);
  });

  // Attach the reverse-tunnel WebSocket endpoint (/agent-tunnel) so remote site
  // agents can dial in and serve their local devices to this server.
  remoteHub.attach(server);

  // Attach the browser-facing live telemetry stream (/ws/telemetry) so the
  // frontend can subscribe to real-time fuel/alarm/GPS updates instead of polling.
  telemetryWs.attach(server);

  // Drive the live telemetry stream: read every connected device on a timer and
  // push fresh frames to WebSocket subscribers. Self-gates when no browser is
  // listening, so it costs nothing until someone opens a live page.
  const _telemetryLoop = setInterval(telemetryPollTick, TELEMETRY_POLL_MS);
  _telemetryLoop.unref?.();  // don't keep the process alive just for this timer
  console.log(`[TelemetryWS] Live poll loop every ${TELEMETRY_POLL_MS}ms (set TELEMETRY_POLL_MS to tune)`);

  // Start per-brand read-only data sources (e.g. Datakom Rainbow). Each adapter
  // self-gates on its own env config, so this is a no-op unless a brand's
  // credentials are set (DK_ENABLED/DK_USER/DK_PASS for Datakom).
  brandAdapters.startAll();

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
