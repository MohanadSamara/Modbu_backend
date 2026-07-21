/**
 * telemetry-ws.js  (SERVER SIDE — browser-facing)
 *
 * Live telemetry push over WebSocket, so the frontend gets real-time fuel /
 * consumption / alarm / GPS updates instead of polling /api/modbus/fuel on a
 * timer. This is the *client* tunnel (browsers), distinct from remote-hub.js's
 * /agent-tunnel (site agents dialing in).
 *
 * Auth: browsers can't set an Authorization header on a WebSocket, so the
 * short-lived access JWT is passed as ?token=… on the connect URL and verified
 * with the same verifyAccessToken() used by the REST middleware.
 *
 * Protocol (JSON text frames):
 *   client → server : { type:'subscribe',   deviceIds:[1,2] }   // [] or omit ⇒ all visible
 *   client → server : { type:'unsubscribe', deviceIds:[1] }
 *   client → server : { type:'ping' }
 *   server → client : { type:'welcome', serverTime }
 *   server → client : { type:'subscribed', deviceIds:[…] }      // after visibility filter
 *   server → client : { type:'telemetry', deviceId, fuel?, consumption?, alarms?, gps?, at }
 *   server → client : { type:'pong', serverTime }
 *
 * index.js calls broadcastTelemetry(deviceId, payload) whenever a fresh reading
 * or alarm snapshot is produced by the fuel poll path.
 */

const { WebSocketServer } = require('ws');
const { verifyAccessToken } = require('./auth');
const { filterVisibleDevices } = require('./nav-scope');

const TELEMETRY_PATH = '/ws/telemetry';

// ws -> { userId, username, deviceIds:Set<number>|null (null = all visible) }
const clients = new Map();

function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (_) {} }

// Keep a subscription to only the devices this user may actually see.
async function filterToVisible(userId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  try {
    const rows = ids.map((id) => ({ id: Number(id) })).filter((r) => Number.isInteger(r.id));
    const visible = await filterVisibleDevices(userId, rows);
    return visible.map((r) => Number(r.id));
  } catch (_) {
    return [];
  }
}

function attach(server) {
  // Use noServer + manual upgrade routing instead of { server, path }. When
  // several WebSocketServers share one HTTP server via the `server` option,
  // each registers its own 'upgrade' listener and destroys sockets whose path
  // it doesn't own — killing the other server's connections. Claiming only our
  // own path here lets this stream and remote-hub's tunnel coexist.
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) { return; }
    if (pathname !== TELEMETRY_PATH) return; // not ours — leave it for another handler
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    let token = null;
    try { token = new URL(req.url, 'http://localhost').searchParams.get('token'); } catch (_) {}
    const payload = token ? verifyAccessToken(token) : null;
    if (!payload) {
      send(ws, { type: 'error', error: 'unauthorized' });
      ws.close(4001, 'unauthorized');
      return;
    }

    // deviceIds = null means "all devices this user can see" (default).
    clients.set(ws, { userId: payload.sub, username: payload.username, deviceIds: null });
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (buf) => handleMessage(ws, buf));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => {});

    send(ws, { type: 'welcome', serverTime: new Date().toISOString() });
  });

  // Keepalive: ping every 30 s, drop dead sockets.
  const iv = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    }
  }, 30_000);
  wss.on('close', () => clearInterval(iv));

  console.log(`[TelemetryWS] Live telemetry stream listening at ${TELEMETRY_PATH}`);
  return wss;
}

async function handleMessage(ws, buf) {
  let msg;
  try { msg = JSON.parse(buf.toString()); } catch (_) { return; }
  const state = clients.get(ws);
  if (!state) return;

  switch (msg.type) {
    case 'ping':
      return send(ws, { type: 'pong', serverTime: new Date().toISOString() });

    case 'subscribe': {
      const requested = Array.isArray(msg.deviceIds) ? msg.deviceIds : [];
      if (requested.length === 0) {
        state.deviceIds = null; // all visible
        return send(ws, { type: 'subscribed', deviceIds: 'all' });
      }
      const allowed = await filterToVisible(state.userId, requested);
      state.deviceIds = new Set(allowed);
      return send(ws, { type: 'subscribed', deviceIds: allowed });
    }

    case 'unsubscribe': {
      const ids = Array.isArray(msg.deviceIds) ? msg.deviceIds.map(Number) : [];
      if (state.deviceIds instanceof Set) {
        for (const id of ids) state.deviceIds.delete(id);
      }
      return send(ws, {
        type: 'subscribed',
        deviceIds: state.deviceIds instanceof Set ? [...state.deviceIds] : 'all',
      });
    }
  }
}

/**
 * Push a telemetry frame for one device to every subscribed client.
 * Called fire-and-forget from the fuel poll path — never throws.
 *
 * When a client is subscribed to "all visible" (deviceIds === null) we confirm
 * visibility lazily against the DB so a stream can't leak devices outside the
 * user's scope.
 */
function broadcastTelemetry(deviceId, payload) {
  const id = Number(deviceId);
  if (!Number.isInteger(id) || clients.size === 0) return;
  const frame = JSON.stringify({ type: 'telemetry', deviceId: id, ...payload });

  for (const [ws, state] of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (state.deviceIds instanceof Set) {
      if (state.deviceIds.has(id)) { try { ws.send(frame); } catch (_) {} }
      continue;
    }
    // "All visible" subscriber — verify scope before sending (best-effort).
    filterVisibleDevices(state.userId, [{ id }])
      .then((rows) => { if (rows.length && ws.readyState === ws.OPEN) { try { ws.send(frame); } catch (_) {} } })
      .catch(() => {});
  }
}

function clientCount() { return clients.size; }

module.exports = { attach, broadcastTelemetry, clientCount, TELEMETRY_PATH };
