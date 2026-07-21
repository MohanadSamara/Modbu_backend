/**
 * remote-hub.js  (SERVER SIDE)
 *
 * Reverse-tunnel hub. Site agents dial OUT to this server over a single
 * WebSocket (so the server never needs to reach into a remote LAN — no VPN,
 * no public IP, no port-forwarding, and overlapping 192.168.x subnets across
 * sites stop mattering because devices are keyed by device_id, not IP).
 *
 * Each agent announces the device_ids it serves. The server then issues RPC
 * requests ("readFuel", "start", …) down the tunnel; the agent runs them
 * against the local Modbus device and replies. `device-io.js` routes a device's
 * ops here whenever isRemote(deviceId) is true, otherwise to the direct-TCP
 * modbus_connect.js.
 *
 * Protocol (JSON text frames):
 *   agent → hub : { type:'hello', agentId, devices:[{deviceId,ip,port}] }
 *   hub  → agent: { type:'hello_ok' }
 *   agent → hub : { type:'status', deviceId, connected }
 *   hub  → agent: { type:'rpc', id, op, deviceId, args }
 *   agent → hub : { type:'rpc_result', id, ok, result?, error? }
 *
 * Auth: shared AGENT_TOKEN passed as ?token= on the tunnel URL, checked at
 * connect. Transport security (wss://) is expected to be terminated by a
 * reverse proxy in production.
 */

const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const AGENT_TOKEN    = process.env.AGENT_TOKEN || '';
const RPC_TIMEOUT_MS = parseInt(process.env.AGENT_RPC_TIMEOUT) || 8000;
const TUNNEL_PATH    = '/agent-tunnel';

// deviceId(number) -> { ws, agentId, ip, port, deviceConnected, lastSeen }
const devices = new Map();
// ws -> { agentId, deviceIds:Set<number> }
const agents = new Map();
// rpc id -> { resolve, timer }
const pending = new Map();

function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (_) {} }

// ── Attach the tunnel to the existing HTTP server ───────────────────────────
function attach(server) {
  if (!AGENT_TOKEN) {
    console.warn('[RemoteHub] AGENT_TOKEN is not set — remote agent tunnel is DISABLED (all agents will be rejected).');
  }
  // Use noServer + manual upgrade routing instead of { server, path }. When
  // several WebSocketServers share one HTTP server via the `server` option,
  // each registers its own 'upgrade' listener and destroys sockets whose path
  // it doesn't own — killing the other server's connections. Claiming only our
  // own path here lets telemetry-ws and this tunnel coexist on the same server.
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) { return; }
    if (pathname !== TUNNEL_PATH) return; // not ours — leave it for another handler
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    let token = null;
    try { token = new URL(req.url, 'http://localhost').searchParams.get('token'); } catch (_) {}
    if (!AGENT_TOKEN || token !== AGENT_TOKEN) {
      console.warn('[RemoteHub] Agent connection rejected: invalid token');
      ws.close(4001, 'unauthorized');
      return;
    }
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (buf) => handleMessage(ws, buf));
    ws.on('close', () => cleanupAgent(ws));
    ws.on('error', () => {});
  });

  // Keepalive: ping every 20 s, drop agents that miss a round-trip.
  const iv = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    }
  }, 20_000);
  wss.on('close', () => clearInterval(iv));

  console.log(`[RemoteHub] Agent tunnel listening at ${TUNNEL_PATH}`);
  return wss;
}

function handleMessage(ws, buf) {
  let msg;
  try { msg = JSON.parse(buf.toString()); } catch (_) { return; }

  switch (msg.type) {
    case 'hello': {
      const agentId = msg.agentId || 'agent';
      const list = Array.isArray(msg.devices) ? msg.devices : [];
      const ids = new Set();
      for (const d of list) {
        const id = Number(d.deviceId);
        if (!Number.isInteger(id)) continue;
        ids.add(id);
        devices.set(id, { ws, agentId, ip: d.ip || null, port: d.port || null, deviceConnected: false, lastSeen: Date.now() });
      }
      agents.set(ws, { agentId, deviceIds: ids });
      console.log(`[RemoteHub] Agent '${agentId}' online — devices: ${[...ids].join(', ') || '(none)'}`);
      send(ws, { type: 'hello_ok' });
      break;
    }
    case 'status': {
      const d = devices.get(Number(msg.deviceId));
      if (d && d.ws === ws) { d.deviceConnected = !!msg.connected; d.lastSeen = Date.now(); }
      break;
    }
    case 'rpc_result': {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg); }
      break;
    }
  }
}

function cleanupAgent(ws) {
  const a = agents.get(ws);
  if (a) {
    for (const id of a.deviceIds) {
      if (devices.get(id)?.ws === ws) devices.delete(id);
    }
    console.log(`[RemoteHub] Agent '${a.agentId}' offline`);
  }
  agents.delete(ws);
}

// ── Query helpers used by device-io.js ──────────────────────────────────────
// A device is "remote" when a live agent is currently serving it.
function isRemote(deviceId) {
  const d = devices.get(Number(deviceId));
  return !!(d && d.ws.readyState === 1 /* OPEN */);
}

function isConnected(deviceId) {
  const d = devices.get(Number(deviceId));
  return !!(d && d.ws.readyState === 1 && d.deviceConnected);
}

// Fire one RPC down the tunnel; resolves with the agent's { ok, result?, error? }.
function callAgent(deviceId, op, args = {}) {
  return new Promise((resolve) => {
    const d = devices.get(Number(deviceId));
    if (!d || d.ws.readyState !== 1) {
      return resolve({ ok: false, error: 'Agent for this device is offline' });
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: `Agent RPC '${op}' timed out after ${RPC_TIMEOUT_MS}ms` });
    }, RPC_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    send(d.ws, { type: 'rpc', id, op, deviceId: Number(deviceId), args });
  });
}

// ── Op wrappers mirroring modbus_connect.js's public surface ─────────────────
async function connect(deviceId) {
  const r = await callAgent(deviceId, 'connect');
  if (r.ok) { const d = devices.get(Number(deviceId)); if (d) d.deviceConnected = true; }
  return { ok: !!r.ok, error: r.error, deviceId: Number(deviceId), remote: true };
}

async function disconnect(deviceId) {
  await callAgent(deviceId, 'disconnect');
  const d = devices.get(Number(deviceId));
  if (d) d.deviceConnected = false;
}

async function readFuel(deviceId) {
  const r = await callAgent(deviceId, 'readFuel');
  return r.ok ? r.result : null;
}

async function readGps(deviceId) {
  const r = await callAgent(deviceId, 'readGps');
  return r.ok ? r.result : null;
}

async function readRegisters(deviceId, start, count = 1) {
  const r = await callAgent(deviceId, 'readRegisters', { start, count });
  return r.ok ? r.result : null;
}

async function readTelemetry(deviceId) {
  const r = await callAgent(deviceId, 'readTelemetry');
  return r.ok ? r.result : null;
}

async function startButton(deviceId) {
  const r = await callAgent(deviceId, 'start');
  return r.ok ? r.result !== false : false;
}

async function stopButton(deviceId) {
  const r = await callAgent(deviceId, 'stop');
  return r.ok ? r.result !== false : false;
}

// Remote devices for getSession() merge.
function session() {
  const out = [];
  for (const [deviceId, d] of devices) {
    out.push({
      deviceId,
      ip: d.ip,
      port: d.port,
      name: null,
      connected: d.deviceConnected,
      autoReconnect: true,
      connectedAt: null,
      remote: true,
      agentId: d.agentId,
    });
  }
  return out;
}

module.exports = {
  attach,
  isRemote,
  isConnected,
  connect,
  disconnect,
  readFuel,
  readGps,
  readRegisters,
  readTelemetry,
  startButton,
  stopButton,
  session,
  callAgent,
};
