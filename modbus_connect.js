/**
 * modbus_connect.js
 *
 * Manages a single persistent Modbus TCP session with:
 *  - Named session (device config stored in memory)
 *  - Automatic reconnect when the socket drops
 *  - Configurable timeout read from system_settings DB table
 *  - Detailed human-readable errors on connect failure
 */

const ModbusRTU = require('modbus-serial');
const { getConnection } = require('./db');
require('dotenv').config();

// ── Single shared client ──────────────────────────────────────────────────
const client = new ModbusRTU();

// ── Session state ─────────────────────────────────────────────────────────
let _connected   = false;

// What we are (or were last) connected to — persists across reconnect cycles
const _session = {
  deviceId:   null,   // numeric DB device_id (null for manual)
  ip:         null,
  port:       null,
  name:       null,
  connectedAt: null,  // Date when connection was established
};

// ── Auto-reconnect state ──────────────────────────────────────────────────
let _autoReconnect  = false;   // enabled once first explicit connect() succeeds
let _reconnectTimer = null;
const RECONNECT_INTERVAL_MS = 10_000;  // try every 10 s after a drop

// ── Env defaults ──────────────────────────────────────────────────────────
const DEFAULT_IP      = process.env.MODBUS_IP   || '192.168.1.20';
const DEFAULT_PORT    = parseInt(process.env.MODBUS_PORT) || 502;
const DEFAULT_TIMEOUT = 5000;

// ─────────────────────────────────────────────────────────────────────────────
// Socket listener — keeps _connected accurate, triggers auto-reconnect
// ─────────────────────────────────────────────────────────────────────────────
function _attachSocketListeners() {
  const socket = client._port?._client ?? client._port?.socket ?? null;
  if (!socket || socket._modbusHubPatched) return;
  socket._modbusHubPatched = true;

  socket.on('close', () => {
    if (!_connected) return;
    console.warn('[Modbus] Socket closed — session dropped');
    _connected = false;
    _scheduleReconnect();
  });

  socket.on('error', (err) => {
    if (!_connected) return;
    console.error('[Modbus] Socket error:', err.message);
    _connected = false;
    _scheduleReconnect();
  });
}

// Patch connectTCP so listeners are attached after every connect call
const _origConnectTCP = client.connectTCP.bind(client);
client.connectTCP = async function (...args) {
  const result = await _origConnectTCP(...args);
  _attachSocketListeners();
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// Auto-reconnect scheduler
// ─────────────────────────────────────────────────────────────────────────────
function _scheduleReconnect() {
  if (!_autoReconnect) return;
  if (_reconnectTimer) return; // already scheduled

  console.log(`[Modbus] Auto-reconnect in ${RECONNECT_INTERVAL_MS / 1000}s…`);
  _reconnectTimer = setTimeout(async () => {
    _reconnectTimer = null;
    if (_connected) return; // recovered by something else

    if (!_session.ip) return; // no session to restore

    console.log(`[Modbus] Auto-reconnect attempt → ${_session.name} @ ${_session.ip}:${_session.port}`);
    const result = await _rawConnect(_session.ip, _session.port, _session.name);
    if (result.ok) {
      console.log('[Modbus] ✓ Auto-reconnect succeeded');
    } else {
      console.warn('[Modbus] ✗ Auto-reconnect failed:', result.error);
      _scheduleReconnect(); // try again after another interval
    }
  }, RECONNECT_INTERVAL_MS);
}

function _cancelReconnect() {
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Read CONNECTION_TIMEOUT from system_settings (uses pool — fast)
// Cached for TIMEOUT_CACHE_MS so we don't hit the DB on every reconnect/poll.
// ─────────────────────────────────────────────────────────────────────────────
let _cachedTimeoutMs = null;
let _cachedTimeoutAt = 0;
const TIMEOUT_CACHE_MS = 5 * 60_000; // 5 min

async function _getTimeoutMs() {
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
      if (!isNaN(val) && val > 0) {
        _cachedTimeoutMs = val;
        _cachedTimeoutAt = Date.now();
        return val;
      }
    }
  } catch { /* ignore */ } finally {
    await conn.close().catch(() => {});
  }
  _cachedTimeoutMs = DEFAULT_TIMEOUT;
  _cachedTimeoutAt = Date.now();
  return DEFAULT_TIMEOUT;
}

// ─────────────────────────────────────────────────────────────────────────────
// Get device config from DB (uses pool — fast)
// ─────────────────────────────────────────────────────────────────────────────
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
         FROM MODBUS_ADMIN.devices
         WHERE status = 'online'
         ORDER BY device_id
         FETCH FIRST 1 ROWS ONLY`,
        []
      );
      if (!result.rows?.length) {
        result = await connection.execute(
          'SELECT device_id, device_ip, device_port, device_name FROM MODBUS_ADMIN.devices ORDER BY device_id FETCH FIRST 1 ROWS ONLY',
          []
        );
      }
    }

    if (!result.rows?.length) {
      console.warn('[Modbus] No devices found in database');
      return null;
    }

    const row = result.rows[0];
    const config = {
      device_id: row[0],
      ip:   row[1],
      port: parseInt(row[2]),
      name: row[3] || 'Unknown',
    };
    console.log(`[Modbus] Device config: ${config.name} @ ${config.ip}:${config.port}`);
    return config;
  } catch (err) {
    console.error('[Modbus] getDeviceConfig error:', err.message);
    return null;
  } finally {
    await connection.close().catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal raw TCP connect (no session bookkeeping)
// Returns { ok: true } or { ok: false, error: string }
// ─────────────────────────────────────────────────────────────────────────────
async function _rawConnect(ip, port, name) {
  const timeoutMs = await _getTimeoutMs();
  console.log(`[Modbus] Connecting to ${name} @ ${ip}:${port} (timeout ${timeoutMs}ms)…`);

  try {
    // Close cleanly if there's an old socket
    if (_connected) {
      try { await client.close(); } catch (_) {}
      _connected = false;
    }

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Connection timed out after ${timeoutMs}ms — device may be off or unreachable at ${ip}:${port}`)),
        timeoutMs
      )
    );

    await Promise.race([client.connectTCP(ip, { port }), timeoutPromise]);
    _attachSocketListeners();
    _connected = true;
    console.log(`[Modbus] ✓ Connected to ${name} @ ${ip}:${port}`);
    return { ok: true };
  } catch (err) {
    _connected = false;
    let reason = err.message || 'Unknown error';
    if (/ECONNREFUSED/i.test(reason))
      reason = `Connection refused — no Modbus listener at ${ip}:${port} (ECONNREFUSED)`;
    else if (/EHOSTUNREACH|ENETUNREACH/i.test(reason))
      reason = `Host unreachable — check network/IP address (${reason})`;
    else if (/ETIMEDOUT|timed out/i.test(reason))
      reason = `Connection timed out — device may be powered off or firewall is blocking port ${port}`;
    else if (/ENOTFOUND/i.test(reason))
      reason = `Hostname not found — verify the IP address`;
    console.error(`[Modbus] ✗ Connect failed: ${reason}`);
    return { ok: false, error: reason };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public connect — resolves config, connects, stores session, starts auto-reconnect
// Returns { ok: true } or { ok: false, error: string }
// ─────────────────────────────────────────────────────────────────────────────
async function connectModbus(deviceId = null, ipOverride = null, portOverride = null) {
  _cancelReconnect(); // stop any pending retry before explicit connect

  let config;
  if (deviceId) {
    config = await getDeviceConfig(parseInt(deviceId));
    if (!config) return { ok: false, error: `Device ID ${deviceId} not found in database` };
  } else if (ipOverride) {
    config = { ip: ipOverride, port: portOverride || DEFAULT_PORT, name: 'Manual', device_id: null };
  } else {
    config = await getDeviceConfig();
    if (!config) return { ok: false, error: 'No devices found in database' };
  }

  const result = await _rawConnect(config.ip, config.port, config.name);

  if (result.ok) {
    // Persist session so it survives tab switches
    _session.deviceId    = config.device_id ?? null;
    _session.ip          = config.ip;
    _session.port        = config.port;
    _session.name        = config.name;
    _session.connectedAt = new Date().toISOString();
    _autoReconnect = true; // arm auto-reconnect for this session
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public disconnect — clears session and disables auto-reconnect
// ─────────────────────────────────────────────────────────────────────────────
async function disconnectModbus() {
  _cancelReconnect();
  _autoReconnect = false;

  // Clear session
  _session.deviceId    = null;
  _session.ip          = null;
  _session.port        = null;
  _session.name        = null;
  _session.connectedAt = null;

  if (_connected) {
    try { await client.close(); } catch (_) {}
    _connected = false;
    console.log('[Modbus] Disconnected by user');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Return current session snapshot (for /api/modbus/session endpoint)
// ─────────────────────────────────────────────────────────────────────────────
function getSession() {
  return {
    connected:    _connected,
    autoReconnect: _autoReconnect,
    deviceId:     _session.deviceId,
    ip:           _session.ip,
    port:         _session.port,
    name:         _session.name,
    connectedAt:  _session.connectedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Controls / readings
// ─────────────────────────────────────────────────────────────────────────────
async function stopButton() {
  try {
    if (!_connected) { console.warn('[Modbus] Not connected'); return false; }
    await client.writeRegister(8193, 1);
    console.log('[Modbus] STOP sent (reg 8193 = 1)');
    return true;
  } catch (err) {
    console.error('[Modbus] stopButton error:', err.message);
    _connected = false;
    _scheduleReconnect();
    return false;
  }
}

async function startButton() {
  try {
    if (!_connected) { console.warn('[Modbus] Not connected'); return false; }
    await client.writeRegister(8193, 8);
    console.log('[Modbus] START press (reg 8193 = 8)');
    await new Promise((r) => setTimeout(r, 100));
    await client.writeRegister(8193, 0);
    console.log('[Modbus] START release (reg 8193 = 0)');
    return true;
  } catch (err) {
    console.error('[Modbus] startButton error:', err.message);
    _connected = false;
    _scheduleReconnect();
    return false;
  }
}

async function readFuel() {
  try {
    if (!_connected) { console.warn('[Modbus] Not connected'); return null; }
    const res  = await client.readHoldingRegisters(10363, 1);
    const fuel = res.data[0] / 10;
    console.log(`[Modbus] Fuel: ${fuel}%`);
    return fuel;
  } catch (err) {
    console.error('[Modbus] readFuel error:', err.message);
    _connected = false;
    _scheduleReconnect();
    return null;
  }
}

function isConnected() { return _connected; }
function getClient()    { return client; }

module.exports = {
  connectModbus,
  disconnectModbus,
  getDeviceConfig,
  getSession,
  isConnected,
  getClient,
  stopButton,
  startButton,
  readFuel,
  client,
};
