/**
 * modbus_connect.js
 *
 * Per-DEVICE Modbus TCP connection manager.
 *
 * Previously this module kept ONE global client for the whole server, so a
 * second user connecting would tear down the first user's socket and repoint
 * the shared client — reads and (dangerously) Start/Stop commands could hit the
 * wrong physical device.
 *
 * Now every device gets its own "hub" (client + session + a per-device request
 * lock), kept in `hubs` keyed by device id (or ip:port for manual connects):
 *   - Two users on the SAME device share that device's one socket (Modbus TCP
 *     slaves usually allow a single connection).
 *   - Two users on DIFFERENT devices get independent sockets.
 *   - All reads/writes on a device are serialized through its lock so requests
 *     from different users never interleave on the one socket.
 *
 * Every public op takes a `target` ({ deviceId? , ip?, port? }) identifying which
 * hub to act on. Auto-reconnect, timeouts, and friendly errors are per-hub.
 */

const ModbusRTU = require('modbus-serial');
const { getConnection } = require('./db');
const ops = require('./shared/modbus-registers'); // authoritative register map (shared with agent)
require('dotenv').config();

// ── Env defaults ──────────────────────────────────────────────────────────
const DEFAULT_IP      = process.env.MODBUS_IP   || '192.168.1.20';
const DEFAULT_PORT    = parseInt(process.env.MODBUS_PORT) || 502;
const DEFAULT_TIMEOUT = 5000;
// The initial TCP handshake must fail fast on a dead/unreachable device. The
// CONNECTION_TIMEOUT system setting governs read/request timeouts and an admin
// may legitimately set it high for slow links — we must NOT inherit that for
// the connect attempt, or the endpoint hangs until the browser aborts and the
// user just sees "request timed out". Bound the handshake to this ceiling.
const CONNECT_TIMEOUT_CEILING = 8000;
const RECONNECT_INTERVAL_MS = 10_000; // retry a dropped hub every 10 s

// ── Hub registry ────────────────────────────────────────────────────────────
// key -> hub. key is `d:<deviceId>` for DB devices, `m:<ip>:<port>` for manual.
const hubs = new Map();

function hubKey({ deviceId = null, ip = null, port = null } = {}) {
  if (deviceId != null && deviceId !== '') return `d:${parseInt(deviceId)}`;
  if (ip) return `m:${ip}:${port || DEFAULT_PORT}`;
  return null;
}

function getOrCreateHub(key, meta) {
  let hub = hubs.get(key);
  if (!hub) {
    hub = {
      key,
      deviceId:   meta.deviceId ?? null,
      ip:         meta.ip,
      port:       meta.port,
      name:       meta.name || 'Device',
      client:     new ModbusRTU(),
      connected:  false,
      connectedAt: null,
      autoReconnect: false,
      reconnectTimer: null,
      lock:       Promise.resolve(), // per-device request mutex (promise chain)
    };
    hubs.set(key, hub);
  } else {
    if (meta.ip)   hub.ip = meta.ip;
    if (meta.port) hub.port = meta.port;
    if (meta.name) hub.name = meta.name;
    if (meta.deviceId != null) hub.deviceId = meta.deviceId;
  }
  return hub;
}

// Resolve an existing hub from request params. Falls back to the only hub when
// no target is given (keeps the single-device CLI / legacy callers working).
function resolveHub(target = {}) {
  const key = hubKey(target);
  if (key) return hubs.get(key) || null;
  if (hubs.size === 1) return [...hubs.values()][0];
  return null;
}

// Serialize every socket op on a hub: chain onto its lock so two users' reads
// or writes never interleave on the one Modbus TCP connection.
function withLock(hub, fn) {
  const run = hub.lock.then(fn, fn);
  hub.lock = run.then(() => {}, () => {}); // swallow so the chain never rejects
  return run;
}

// ── Socket listeners (per hub) ──────────────────────────────────────────────
function attachSocketListeners(hub) {
  const socket = hub.client._port?._client ?? hub.client._port?.socket ?? null;
  if (!socket || socket._modbusHubPatched) return;
  socket._modbusHubPatched = true;

  socket.on('close', () => {
    if (!hub.connected) return;
    console.warn(`[Modbus] Socket closed — ${hub.name} (${hub.key}) dropped`);
    hub.connected = false;
    scheduleReconnect(hub);
  });
  socket.on('error', (err) => {
    if (!hub.connected) return;
    console.error(`[Modbus] Socket error on ${hub.name} (${hub.key}):`, err.message);
    hub.connected = false;
    scheduleReconnect(hub);
  });
}

// ── Auto-reconnect (per hub) ────────────────────────────────────────────────
function scheduleReconnect(hub) {
  if (!hub.autoReconnect || hub.reconnectTimer) return;
  console.log(`[Modbus] Auto-reconnect for ${hub.name} in ${RECONNECT_INTERVAL_MS / 1000}s…`);
  hub.reconnectTimer = setTimeout(async () => {
    hub.reconnectTimer = null;
    if (hub.connected || !hub.ip) return;
    const r = await withLock(hub, () => rawConnect(hub));
    if (r.ok) console.log(`[Modbus] ✓ Auto-reconnect ${hub.name}`);
    else { console.warn(`[Modbus] ✗ Auto-reconnect ${hub.name}: ${r.error}`); scheduleReconnect(hub); }
  }, RECONNECT_INTERVAL_MS);
}

function cancelReconnect(hub) {
  if (hub.reconnectTimer) { clearTimeout(hub.reconnectTimer); hub.reconnectTimer = null; }
}

// ── CONNECTION_TIMEOUT from system_settings (cached) ────────────────────────
let _cachedTimeoutMs = null;
let _cachedTimeoutAt = 0;
const TIMEOUT_CACHE_MS = 5 * 60_000;

async function getTimeoutMs() {
  if (_cachedTimeoutMs !== null && (Date.now() - _cachedTimeoutAt) < TIMEOUT_CACHE_MS) {
    return _cachedTimeoutMs;
  }
  const conn = await getConnection();
  if (!conn) return _cachedTimeoutMs ?? DEFAULT_TIMEOUT;
  try {
    const result = await conn.execute(
      "SELECT setting_value FROM MODBUS_ADMIN.system_settings WHERE setting_key = 'CONNECTION_TIMEOUT'"
    );
    if (result.rows?.length > 0) {
      const val = parseInt(result.rows[0][0]);
      if (!isNaN(val) && val > 0) { _cachedTimeoutMs = val; _cachedTimeoutAt = Date.now(); return val; }
    }
  } catch { /* ignore */ } finally {
    await conn.close().catch(() => {});
  }
  _cachedTimeoutMs = DEFAULT_TIMEOUT;
  _cachedTimeoutAt = Date.now();
  return DEFAULT_TIMEOUT;
}

// ── Device config from DB ───────────────────────────────────────────────────
async function getDeviceConfig(deviceId = null) {
  const connection = await getConnection();
  if (!connection) {
    console.warn('[Modbus] DB unavailable — using env fallback');
    return {
      device_id: parseInt(deviceId) || 1,
      ip:   process.env.MODBUS_IP   || DEFAULT_IP,
      port: parseInt(process.env.MODBUS_PORT) || DEFAULT_PORT,
      name: 'DB Fallback Device',
    };
  }
  try {
    let result;
    if (deviceId) {
      result = await connection.execute(
        'SELECT device_id, device_ip, device_port, device_name FROM MODBUS_ADMIN.devices WHERE device_id = :id',
        { id: parseInt(deviceId) }
      );
    } else {
      result = await connection.execute(
        `SELECT device_id, device_ip, device_port, device_name
           FROM MODBUS_ADMIN.devices WHERE status = 'online'
          ORDER BY device_id FETCH FIRST 1 ROWS ONLY`, []
      );
      if (!result.rows?.length) {
        result = await connection.execute(
          'SELECT device_id, device_ip, device_port, device_name FROM MODBUS_ADMIN.devices ORDER BY device_id FETCH FIRST 1 ROWS ONLY', []
        );
      }
    }
    if (!result.rows?.length) { console.warn('[Modbus] No devices found in database'); return null; }
    const row = result.rows[0];
    const config = { device_id: row[0], ip: row[1], port: parseInt(row[2]), name: row[3] || 'Unknown' };
    console.log(`[Modbus] Device config: ${config.name} @ ${config.ip}:${config.port}`);
    return config;
  } catch (err) {
    console.error('[Modbus] getDeviceConfig error:', err.message);
    return null;
  } finally {
    await connection.close().catch(() => {});
  }
}

// ── Raw TCP connect for a hub ───────────────────────────────────────────────
async function rawConnect(hub) {
  // Cap the handshake so a dead device fails fast even when CONNECTION_TIMEOUT
  // (a read/request setting) is configured high. See CONNECT_TIMEOUT_CEILING.
  const timeoutMs = Math.min(await getTimeoutMs(), CONNECT_TIMEOUT_CEILING);
  console.log(`[Modbus] Connecting to ${hub.name} @ ${hub.ip}:${hub.port} (timeout ${timeoutMs}ms)…`);
  let timer = null;
  try {
    if (hub.connected) { try { await hub.client.close(); } catch (_) {} hub.connected = false; }
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(
        `Connection timed out after ${timeoutMs}ms — device may be off or unreachable at ${hub.ip}:${hub.port}`
      )), timeoutMs);
    });
    await Promise.race([hub.client.connectTCP(hub.ip, { port: hub.port }), timeoutPromise]);
    clearTimeout(timer);
    attachSocketListeners(hub);
    hub.connected = true;
    hub.connectedAt = new Date().toISOString();
    console.log(`[Modbus] ✓ Connected to ${hub.name} @ ${hub.ip}:${hub.port}`);
    return { ok: true };
  } catch (err) {
    clearTimeout(timer);
    hub.connected = false;
    // A timed-out handshake leaves a half-open socket still trying to connect in
    // the background. Close it so the next attempt starts clean and sockets
    // don't accumulate on repeated failures.
    try { await hub.client.close(); } catch (_) {}
    let reason = err.message || 'Unknown error';
    if (/ECONNREFUSED/i.test(reason))            reason = `Connection refused — no Modbus listener at ${hub.ip}:${hub.port} (ECONNREFUSED)`;
    else if (/EHOSTUNREACH|ENETUNREACH/i.test(reason)) reason = `Host unreachable — check network/IP address (${reason})`;
    else if (/ETIMEDOUT|timed out/i.test(reason)) reason = `Connection timed out — device may be powered off or firewall is blocking port ${hub.port}`;
    else if (/ENOTFOUND/i.test(reason))           reason = `Hostname not found — verify the IP address`;
    console.error(`[Modbus] ✗ Connect failed (${hub.name}): ${reason}`);
    return { ok: false, error: reason };
  }
}

// ── Public: connect ─────────────────────────────────────────────────────────
// Get-or-create the device's hub and connect it. If already connected, the
// caller simply shares the existing socket (returns ok immediately).
async function connectModbus(deviceId = null, ipOverride = null, portOverride = null) {
  let meta;
  if (deviceId != null) {
    const cfg = await getDeviceConfig(parseInt(deviceId));
    if (!cfg) return { ok: false, error: `Device ID ${deviceId} not found in database` };
    meta = { deviceId: cfg.device_id, ip: cfg.ip, port: cfg.port, name: cfg.name };
  } else if (ipOverride) {
    meta = { deviceId: null, ip: ipOverride, port: portOverride || DEFAULT_PORT, name: 'Manual' };
  } else {
    const cfg = await getDeviceConfig();
    if (!cfg) return { ok: false, error: 'No devices found in database' };
    meta = { deviceId: cfg.device_id, ip: cfg.ip, port: cfg.port, name: cfg.name };
  }

  const key = hubKey(meta);
  const hub = getOrCreateHub(key, meta);
  cancelReconnect(hub);

  // Already connected → share it (second user joins the same socket).
  if (hub.connected) return { ok: true, deviceId: hub.deviceId, shared: true };

  const result = await withLock(hub, () => rawConnect(hub));
  if (result.ok) hub.autoReconnect = true; // arm reconnect for this hub
  return { ...result, deviceId: hub.deviceId };
}

// ── Public: disconnect ──────────────────────────────────────────────────────
async function disconnectModbus(target = {}) {
  const hub = resolveHub(target);
  if (!hub) return;
  cancelReconnect(hub);
  hub.autoReconnect = false;
  if (hub.connected) {
    try { await hub.client.close(); } catch (_) {}
    hub.connected = false;
    console.log(`[Modbus] Disconnected ${hub.name} by user`);
  }
  hubs.delete(hub.key);
}

// Close every hub (graceful server shutdown).
async function closeAll() {
  for (const hub of hubs.values()) {
    cancelReconnect(hub);
    if (hub.connected) { try { await hub.client.close(); } catch (_) {} hub.connected = false; }
  }
  hubs.clear();
}

// ── Public: session snapshot (all hubs) ─────────────────────────────────────
function getSession() {
  const devices = [];
  for (const hub of hubs.values()) {
    devices.push({
      deviceId:    hub.deviceId,
      ip:          hub.ip,
      port:        hub.port,
      name:        hub.name,
      connected:   hub.connected,
      autoReconnect: hub.autoReconnect,
      connectedAt: hub.connectedAt,
    });
  }
  const firstConnected = devices.find((d) => d.connected) || null;
  return {
    connected: devices.some((d) => d.connected),
    deviceId:  firstConnected?.deviceId ?? null, // legacy single-device field
    devices,
  };
}

function isConnected(target = {}) {
  const hub = resolveHub(target);
  return !!hub && hub.connected;
}

// ── Controls / readings (per hub, serialized) ───────────────────────────────
async function stopButton(target = {}) {
  const hub = resolveHub(target);
  if (!hub || !hub.connected) { console.warn('[Modbus] Not connected (stop)'); return false; }
  return withLock(hub, async () => {
    try {
      await hub.client.writeRegister(8193, 1);
      console.log(`[Modbus] STOP → ${hub.name} (reg 8193 = 1)`);
      return true;
    } catch (err) {
      console.error(`[Modbus] stopButton error (${hub.name}):`, err.message);
      hub.connected = false; scheduleReconnect(hub); return false;
    }
  });
}

async function startButton(target = {}) {
  const hub = resolveHub(target);
  if (!hub || !hub.connected) { console.warn('[Modbus] Not connected (start)'); return false; }
  return withLock(hub, async () => {
    try {
      await hub.client.writeRegister(8193, 8);
      await new Promise((r) => setTimeout(r, 100));
      await hub.client.writeRegister(8193, 0);
      console.log(`[Modbus] START → ${hub.name} (reg 8193 press/release)`);
      return true;
    } catch (err) {
      console.error(`[Modbus] startButton error (${hub.name}):`, err.message);
      hub.connected = false; scheduleReconnect(hub); return false;
    }
  });
}

async function readFuel(target = {}) {
  const hub = resolveHub(target);
  if (!hub || !hub.connected) { console.warn('[Modbus] Not connected (fuel)'); return null; }
  return withLock(hub, async () => {
    try {
      // Delegate to the shared register logic so the fuel scale + sentinel
      // validation can never drift from the agent/telemetry paths.
      return await ops.readFuel(hub.client);
    } catch (err) {
      console.error(`[Modbus] readFuel error (${hub.name}):`, err.message);
      hub.connected = false; scheduleReconnect(hub); return null;
    }
  });
}

// ── GPS position (registers 10594/10596/10598, 32-bit each) ─────────────────
// The manual's DATA FORMATS section: 32-bit values span two consecutive
// registers, high word first — so reading 6 registers from 10594 gives a 12-byte
// buffer we decode as three big-endian signed 32-bit integers (lat, lon, alt).
//
// The scale factor for these registers is NOT documented by Datakom. 1e6
// (micro-degrees) is the most common GPS-over-Modbus encoding. If a connected
// device reports coordinates that are off, calibrate GPS_DIVISOR against a known
// position — the raw integers are logged and returned as latitudeRaw/longitudeRaw
// so you can compute the correct factor in one step.
const GPS_DIVISOR = 1_000_000; // raw integer -> decimal degrees

async function readGps(target = {}) {
  const hub = resolveHub(target);
  if (!hub || !hub.connected) { console.warn('[Modbus] Not connected (gps)'); return null; }
  return withLock(hub, async () => {
    try {
      // 10594 lat[2], 10596 lon[2], 10598 alt[2]
      const res = await hub.client.readHoldingRegisters(10594, 6);
      const buf = res.buffer; // 12 bytes, big-endian words
      const latRaw = buf.readInt32BE(0);
      const lonRaw = buf.readInt32BE(4);
      const altRaw = buf.readInt32BE(8);

      const latitude  = latRaw / GPS_DIVISOR;
      const longitude = lonRaw / GPS_DIVISOR;
      const altitude  = altRaw; // metres (no documented coefficient)

      console.log(
        `[Modbus] GPS ${hub.name}: raw lat=${latRaw} lon=${lonRaw} alt=${altRaw} ` +
        `→ ${latitude}, ${longitude} (${altitude}m)`
      );

      // A device with no GPS fix usually reports 0/0; treat that as "no fix"
      // rather than plotting a marker in the Gulf of Guinea.
      const hasFix = latRaw !== 0 || lonRaw !== 0;
      const valid  = Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;

      return {
        latitude, longitude, altitude,
        latitudeRaw: latRaw, longitudeRaw: lonRaw, altitudeRaw: altRaw,
        hasFix, valid,
      };
    } catch (err) {
      console.error(`[Modbus] readGps error (${hub.name}):`, err.message);
      hub.connected = false; scheduleReconnect(hub); return null;
    }
  });
}

// ── Generic raw register read (Modbus function 3) ───────────────────────────
// Delegates the decode to the shared register map; this wrapper only adds the
// per-hub lock + connection/reconnect handling.
async function readRegisters(target = {}, start, count = 1) {
  const hub = resolveHub(target);
  if (!hub || !hub.connected) { console.warn('[Modbus] Not connected (readRegisters)'); return null; }
  return withLock(hub, async () => {
    try {
      return await ops.readRegisters(hub.client, start, count);
    } catch (err) {
      console.error(`[Modbus] readRegisters error (${hub.name}):`, err.message);
      hub.connected = false; scheduleReconnect(hub); return null;
    }
  });
}

// ── Combined telemetry snapshot (engine block + RPM + battery + GPS) ─────────
// Delegates to the shared readTelemetry so the server and the remote agent
// decode identical registers with identical coefficients.
async function readTelemetry(target = {}) {
  const hub = resolveHub(target);
  if (!hub || !hub.connected) { console.warn('[Modbus] Not connected (telemetry)'); return null; }
  return withLock(hub, async () => {
    try {
      return await ops.readTelemetry(hub.client);
    } catch (err) {
      console.error(`[Modbus] readTelemetry error (${hub.name}):`, err.message);
      hub.connected = false; scheduleReconnect(hub); return null;
    }
  });
}

module.exports = {
  connectModbus,
  disconnectModbus,
  closeAll,
  getDeviceConfig,
  getSession,
  isConnected,
  stopButton,
  startButton,
  readFuel,
  readGps,
  readRegisters,
  readTelemetry,
};
