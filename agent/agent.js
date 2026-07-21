/**
 * agent/agent.js  (SITE AGENT — runs on the remote network next to the device)
 *
 * Solves the "device is on a different / remote network" problem WITHOUT a VPN
 * or a public IP. The agent:
 *   1. talks to the local Modbus device over its LAN (easy — same subnet), and
 *   2. dials OUT to the central server over one WebSocket tunnel and executes
 *      the read/command RPCs the server sends.
 *
 * Because the connection is outbound, the site needs nothing but ordinary
 * internet — no inbound ports, no static IP. Overlapping 192.168.x subnets
 * across sites are irrelevant: the server addresses devices by device_id.
 *
 * Config (see .env.example):
 *   SERVER_URL   ws://your-server:3000   (or wss:// behind TLS)
 *   AGENT_TOKEN  shared secret, must match the server's AGENT_TOKEN
 *   AGENT_ID     friendly name for logs
 *   DEVICES      JSON: [{"deviceId":1,"ip":"192.168.1.10","port":502,"unitId":1}]
 *                (or a single device via DEVICE_ID / DEVICE_IP / DEVICE_PORT)
 */

// Load THIS agent's .env regardless of the working directory it's launched from
// (systemd, Task Scheduler, or `node agent/agent.js` from the repo root).
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const WebSocket  = require('ws');
const ModbusRTU  = require('modbus-serial');
const ops        = require('../shared/modbus-registers');

// ── Config ──────────────────────────────────────────────────────────────────
const SERVER_URL     = (process.env.SERVER_URL || 'ws://localhost:3000').replace(/\/+$/, '');
const AGENT_TOKEN    = process.env.AGENT_TOKEN || '';
const AGENT_ID       = process.env.AGENT_ID || 'site-agent';
const CONNECT_TIMEOUT_MS = parseInt(process.env.DEVICE_TIMEOUT) || 5000;
const RECONNECT_MIN_MS   = 2000;
const RECONNECT_MAX_MS   = 30_000;
const STATUS_INTERVAL_MS = 15_000;

function loadDevices() {
  if (process.env.DEVICES) {
    try {
      return JSON.parse(process.env.DEVICES).map((d) => ({
        deviceId: Number(d.deviceId),
        ip: d.ip,
        port: Number(d.port) || 502,
        unitId: Number(d.unitId) || 1,
      }));
    } catch (e) {
      console.error('[Agent] DEVICES is not valid JSON:', e.message);
      process.exit(1);
    }
  }
  if (process.env.DEVICE_ID && process.env.DEVICE_IP) {
    return [{
      deviceId: Number(process.env.DEVICE_ID),
      ip: process.env.DEVICE_IP,
      port: Number(process.env.DEVICE_PORT) || 502,
      unitId: Number(process.env.DEVICE_UNIT_ID) || 1,
    }];
  }
  console.error('[Agent] No devices configured. Set DEVICES or DEVICE_ID/DEVICE_IP.');
  process.exit(1);
}

// deviceId -> { deviceId, ip, port, unitId, client, connected, lock }
const devices = new Map();
for (const d of loadDevices()) {
  devices.set(d.deviceId, { ...d, client: null, connected: false, lock: Promise.resolve() });
}

let ws = null;
let reconnectDelay = RECONNECT_MIN_MS;

// Serialize every op on a device so two concurrent RPCs never interleave on the
// one Modbus TCP socket (mirrors the server's per-hub lock).
function withLock(dev, fn) {
  const run = dev.lock.then(fn, fn);
  dev.lock = run.then(() => {}, () => {});
  return run;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label || `timed out after ${ms}ms`)), ms)),
  ]);
}

// ── Local device connection ─────────────────────────────────────────────────
async function ensureDevice(dev) {
  if (dev.connected && dev.client) return true;
  try {
    if (dev.client) { try { await dev.client.close(); } catch (_) {} }
    dev.client = new ModbusRTU();
    await withTimeout(
      dev.client.connectTCP(dev.ip, { port: dev.port }),
      CONNECT_TIMEOUT_MS,
      `connect timed out after ${CONNECT_TIMEOUT_MS}ms — device may be off at ${dev.ip}:${dev.port}`
    );
    dev.client.setID(dev.unitId);
    dev.connected = true;
    console.log(`[Agent] ✓ Connected local device ${dev.deviceId} @ ${dev.ip}:${dev.port}`);
    sendStatus(dev);
    return true;
  } catch (e) {
    dev.connected = false;
    console.warn(`[Agent] ✗ Device ${dev.deviceId} @ ${dev.ip}:${dev.port}: ${e.message}`);
    sendStatus(dev);
    return false;
  }
}

async function closeDevice(dev) {
  if (dev.client) { try { await dev.client.close(); } catch (_) {} }
  dev.connected = false;
  sendStatus(dev);
}

function markDeviceDown(dev) {
  dev.connected = false;
  sendStatus(dev);
}

// ── RPC handling ────────────────────────────────────────────────────────────
async function handleRpc(msg) {
  const dev = devices.get(Number(msg.deviceId));
  if (!dev) return reply(msg.id, false, null, `Device ${msg.deviceId} is not served by this agent`);

  return withLock(dev, async () => {
    try {
      switch (msg.op) {
        case 'connect': {
          const ok = await ensureDevice(dev);
          return reply(msg.id, ok, ok, ok ? null : 'Device unreachable');
        }
        case 'disconnect':
          await closeDevice(dev);
          return reply(msg.id, true, true);
        case 'status':
          return reply(msg.id, true, { connected: dev.connected });
        case 'readFuel': {
          if (!(await ensureDevice(dev))) return reply(msg.id, false, null, 'Device unreachable');
          const f = await ops.readFuel(dev.client);
          return reply(msg.id, true, f);
        }
        case 'readGps': {
          if (!(await ensureDevice(dev))) return reply(msg.id, false, null, 'Device unreachable');
          const g = await ops.readGps(dev.client);
          return reply(msg.id, true, g);
        }
        case 'readRegisters': {
          if (!(await ensureDevice(dev))) return reply(msg.id, false, null, 'Device unreachable');
          const r = await ops.readRegisters(dev.client, msg.args?.start, msg.args?.count);
          return reply(msg.id, true, r);
        }
        case 'readTelemetry': {
          if (!(await ensureDevice(dev))) return reply(msg.id, false, null, 'Device unreachable');
          const t = await ops.readTelemetry(dev.client);
          return reply(msg.id, true, t);
        }
        case 'start': {
          if (!(await ensureDevice(dev))) return reply(msg.id, false, null, 'Device unreachable');
          await ops.start(dev.client);
          return reply(msg.id, true, true);
        }
        case 'stop': {
          if (!(await ensureDevice(dev))) return reply(msg.id, false, null, 'Device unreachable');
          await ops.stop(dev.client);
          return reply(msg.id, true, true);
        }
        default:
          return reply(msg.id, false, null, `Unknown op '${msg.op}'`);
      }
    } catch (e) {
      // A socket-level failure means the device dropped — mark down so it
      // reconnects on the next op, and surface the error to the server.
      markDeviceDown(dev);
      return reply(msg.id, false, null, e.message);
    }
  });
}

function reply(id, ok, result, error) {
  wsSend({ type: 'rpc_result', id, ok, result, error });
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

function sendStatus(dev) {
  wsSend({ type: 'status', deviceId: dev.deviceId, connected: dev.connected });
}

// ── Tunnel to the server ────────────────────────────────────────────────────
function connectTunnel() {
  const url = `${SERVER_URL}/agent-tunnel?token=${encodeURIComponent(AGENT_TOKEN)}`;
  console.log(`[Agent] Connecting tunnel → ${SERVER_URL}/agent-tunnel …`);
  ws = new WebSocket(url);

  ws.on('open', () => {
    reconnectDelay = RECONNECT_MIN_MS;
    console.log(`[Agent] ✓ Tunnel open (agent '${AGENT_ID}')`);
    wsSend({
      type: 'hello',
      agentId: AGENT_ID,
      devices: [...devices.values()].map((d) => ({ deviceId: d.deviceId, ip: d.ip, port: d.port })),
    });
    // Try to bring devices up right away so the server sees live status.
    for (const dev of devices.values()) withLock(dev, () => ensureDevice(dev));
  });

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch (_) { return; }
    if (msg.type === 'rpc') handleRpc(msg);
    else if (msg.type === 'hello_ok') console.log('[Agent] Server acknowledged registration');
  });

  ws.on('close', (code) => {
    console.warn(`[Agent] Tunnel closed (code ${code}) — retrying in ${reconnectDelay / 1000}s`);
    scheduleReconnect();
  });
  ws.on('error', (err) => {
    console.warn(`[Agent] Tunnel error: ${err.message}`);
    // 'close' fires after 'error'; reconnect is scheduled there.
  });
}

function scheduleReconnect() {
  setTimeout(connectTunnel, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

// Periodically re-announce device status (also nudges reconnect of dropped devices).
setInterval(() => {
  for (const dev of devices.values()) {
    if (!dev.connected) withLock(dev, () => ensureDevice(dev));
    else sendStatus(dev);
  }
}, STATUS_INTERVAL_MS);

// ── Boot ─────────────────────────────────────────────────────────────────────
if (!AGENT_TOKEN) {
  console.error('[Agent] AGENT_TOKEN is required (must match the server).');
  process.exit(1);
}
console.log(`[Agent] '${AGENT_ID}' starting — serving devices: ${[...devices.keys()].join(', ')}`);
connectTunnel();

process.on('SIGINT',  async () => { for (const d of devices.values()) await closeDevice(d); process.exit(0); });
process.on('SIGTERM', async () => { for (const d of devices.values()) await closeDevice(d); process.exit(0); });
