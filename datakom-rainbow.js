/**
 * datakom-rainbow.js
 *
 * READ-ONLY live data source for devices of the "Datakom" brand.
 *
 * Datakom's Rainbow SCADA portal (cs.datakom.com.tr, a Flutter app) talks to its
 * backend over a single WebSocket: wss://rm.datakom.com.tr:464/. Instead of
 * driving a headless browser, this module speaks that same protocol directly.
 *
 * The protocol below is CONFIRMED against three sources:
 *   1. Datakom's official application note "Remote Procedure Call on Rainbow
 *      Scada" (Issue 01) — endpoint, message flow, demo account.
 *   2. Datakom's own reference client `RS_test_json` (RainbowScadaClient.cs).
 *   3. A real captured session log (State: "Connected...") from a whitelisted
 *      network.
 *
 * Handshake / flow (exactly as the reference client performs it):
 *   1. connect wss://rm.datakom.com.tr:464/  (auth is IN-BAND, over messages)
 *   2. server → { Request:"usr_fedai", fedai:"DKWS.RT.Fedai.Rakam = …" }  (challenge)
 *   3. client → { Request:"usr_login", UsrNam, UsrPwd, ComIdt:-1, AppMod:"V",
 *                 MsgPrm:"NONE"|"JSON"|"DATA", Random:<.NET ticks>, RndNum:<answer> }
 *   4. server → { Request:"usr_login", Access, SrvLic, ComLic }   (Access>=1 = ok)
 *   5. server → { Request:"node_list", NodeList:[{id,parent,name}] }
 *   6. client → { Request:"devx_list", Node:<id>, Skip:0 }        (per node, paginated)
 *   7. server → { Request:"devx_list", Node, Skip, Last, DevxList:[{did,sid,esn,lat,lng}] }
 *   8. client → { Request:"devx_pump", job:1 }                    (after all nodes)
 *   9. server → { Request:"devx_pump", job:2 }                    (pump primed → live data flows)
 *  10. server → { Request:"dump_devm"|"dump_gway", did, slx, rcvt, errt,
 *                 node_id:[…], MSG:{ VALUE:[{A,N,V,U}], EXTRA:{…} } }   (live readings)
 *
 * IMPORTANT — port 464 is IP-ALLOWLISTED by Datakom. A non-whitelisted source IP
 * gets the TLS handshake reset (ECONNRESET) before login. This adapter must run
 * from a host whose public IP Datakom has whitelisted, or it will never connect.
 *
 * Live DATA is read-only. Remote control (start/stop) is SCAFFOLDED in sendControl()
 * near the bottom of this file — fully wired end-to-end but INERT until the Rainbow
 * command frame is captured and filled into buildControlFrame(), so we never send a
 * guessed frame to a real generator. The Modbus + agent path remains the platform's
 * primary control channel.
 *
 * Config (all via env — never hard-code the password):
 *   DK_ENABLED   1|true to activate (default off)
 *   DK_WS_URL    wss://rm.datakom.com.tr:464/   (Datakom's documented endpoint)
 *   DK_USER      portal username
 *   DK_PASS      portal password
 *   DK_PUSH      0=NO-PUSH (MsgPrm NONE, default), 1=JSON push, 2=DATA push
 *   DK_INSECURE  1 to skip TLS cert validation (only if the cert is broken)
 *   DK_VERBOSE   1 to log per-cycle connect/close/error chatter (default quiet)
 *   DK_REPUMP_MS live-subscription refresh cadence in ms (default 8000, min 3000)
 */

const WebSocket = require('ws');

// ── Config ──────────────────────────────────────────────────────────────────
const CFG = {
  url:      process.env.DK_WS_URL  || 'wss://rm.datakom.com.tr:464/',
  user:     process.env.DK_USER    || '',
  pass:     process.env.DK_PASS    || '',
  // Default to JSON push (1): the server then STREAMS live dump frames on its own.
  // NO-PUSH (0) delivers nothing automatically. DATA push (2) is the binary variant.
  push:     process.env.DK_PUSH == null || process.env.DK_PUSH === '' ? 1 : parseInt(process.env.DK_PUSH, 10),
  insecure: /^(1|true|yes|on)$/i.test(process.env.DK_INSECURE || ''),
  enabled:  /^(1|true|yes|on)$/i.test(process.env.DK_ENABLED  || ''),
  verbose:  /^(1|true|yes|on)$/i.test(process.env.DK_VERBOSE  || ''),
};

const RECONNECT_MIN_MS   = 5_000;
const RECONNECT_MAX_MS   = 300_000;  // 5 min — back off HARD on repeated failure
const MAX_FAILED_CYCLES  = 8;        // then stop, so we never hammer / get IP-banned
// Re-prime the live subscription on this cadence (also a keepalive). Lower =
// fresher data if Datakom batches per pump; tune with DK_REPUMP_MS. Floored at
// 3 s so we never hammer the portal.
const REPUMP_MS          = Math.max(3_000, Number(process.env.DK_REPUMP_MS) || 8_000);
const MAX_RECENT         = 300;      // raw frames kept for inspection

// ── State ────────────────────────────────────────────────────────────────────
let ws = null;
let starting = false;
let ready = false;                 // logged in (session established)
let session = null;                // { Access, ComNam }
let connectedAt = null;
let lastError = null;
let reconnectDelay = RECONNECT_MIN_MS;
let repumpTimer = null;
let reconnectTimer = null;         // pending scheduleReconnect timeout (cancellable)
let failedCycles = 0;              // consecutive connects that never reached login
let gaveUp = false;                // stopped reconnecting to avoid hammering the server
let stopped = false;               // explicitly stopped via stop() — no reconnects
// Runtime enable override (null = follow env DK_ENABLED). Persisted by index.js
// in system_settings (DK_ADAPTER_ENABLED) and applied at boot via setEnabled().
let enabledOverride = null;

function isEnabled() { return enabledOverride != null ? enabledOverride : CFG.enabled; }

// Tree/device bookkeeping for the paginated devx_list walk.
let nodes = [];                    // [{ id, parent, name }]
let nodeCursor = 0;               // index into `nodes` currently being paged

const devicesById   = new Map();   // did(number) -> { did, sid, esn, lat, lng, ... }
const readingsById  = new Map();   // did(number) -> { ...parsed, raw, readAt }
const nameToId      = new Map();   // normalized sid -> did
const recentFrames  = [];          // last MAX_RECENT received frames (for calibration)

const norm = (s) => String(s ?? '').trim().toLowerCase();

// ── Fedai challenge solver ────────────────────────────────────────────────────
// The challenge is a sequence of compound assignments to a variable named
// "DKWS.RT.Fedai.Rakam", terminated by "DKWS.RT.Fedai.Bitti". Example:
//   "DKWS.RT.Fedai.Rakam = 11; DKWS.RT.Fedai.Rakam += 20; DKWS.RT.Fedai.Rakam *= 29; … DKWS.RT.Fedai.Bitti = …;"
// Evaluate the ops IN ORDER; the final value is the RndNum answer. Arithmetic is
// done in 32-bit int semantics to exactly match the C# reference client (which
// uses `int`, so multiplication wraps on overflow).
function solveFedai(fedai) {
  const s = String(fedai ?? '');
  const bitti = s.indexOf('DKWS.RT.Fedai.Bitti');
  const head = bitti >= 0 ? s.slice(0, bitti) : s;

  const steps = head
    .split('DKWS.RT.Fedai.Rakam')
    .map((p) => p.trim().replace(/;+$/, '').trim())
    .filter((p) => p.length > 0);

  let rakam = 0;
  for (const step of steps) {
    const op = step[0];                       // '=', '+', '-', '*', '/'
    const eq = step.indexOf('= ');
    if (eq < 0) continue;
    const n = parseInt(step.slice(eq + 2).trim(), 10);
    if (Number.isNaN(n)) continue;
    switch (op) {
      case '=': rakam = n | 0;                break;
      case '+': rakam = (rakam + n) | 0;      break;
      case '-': rakam = (rakam - n) | 0;      break;
      case '*': rakam = Math.imul(rakam, n);  break;  // int32 multiply (wraps like C# int)
      case '/': rakam = (n === 0 ? 0 : (rakam / n) | 0); break;
    }
  }
  return rakam;
}

// C#'s reference client sends `Random = DateTime.Today.Ticks` — the wall-clock
// tick count (100 ns units since 0001-01-01) of local midnight. Replicated here
// exactly (verified: 2016-07-11 → 636037920000000000). Returned as BigInt so the
// full 18-digit value survives (it exceeds Number.MAX_SAFE_INTEGER).
const TICKS_EPOCH_OFFSET_MS = 62135596800000n; // ms from 0001-01-01 to 1970-01-01
function dotNetTodayTicks() {
  const now = new Date();
  const wallMidnightMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return (BigInt(wallMidnightMs) + TICKS_EPOCH_OFFSET_MS) * 10000n;
}

// ── Reading parser ────────────────────────────────────────────────────────────
// A live frame's MSG.VALUE is an array of { A:<addr>, N:<name>, V:<value str>, U:<unit> }.
// We expose the full name→{value,unit} map (so nothing is lost) and additionally
// best-guess a few common fields by name. Field NAMES are Datakom's, taken from
// the reference client + captured logs (e.g. "Engine Oil Temp", "Mains L1").
const num = (v) => { const n = parseFloat(String(v)); return Number.isFinite(n) ? n : null; };

// Scan a reading's values for something shaped like an IPv4 address, so a device
// that reports its LAN/remote IP over the cloud can have that IP surfaced into the
// platform device record (enabling a Modbus/IP fallback). Fields whose NAME hints
// at an address (contains "ip"/"addr") are preferred over a blind scan.
const IPV4_RE = /^\s*(?:\d{1,3}\.){3}\d{1,3}\s*$/;
function extractIp(values) {
  if (!values) return null;
  const entries = Object.entries(values);
  const hinted = entries.filter(([k]) => /ip|addr/i.test(k));
  for (const [, v] of [...hinted, ...entries]) {
    const raw = v && (v.raw ?? v.value);
    if (raw != null && IPV4_RE.test(String(raw))) return String(raw).trim();
  }
  return null;
}

function parseReading(msg) {
  const did = Number(msg.did);
  if (!Number.isFinite(did)) return null;
  const MSG = msg.MSG || {};
  const VALUE = Array.isArray(MSG.VALUE) ? MSG.VALUE : [];
  const EXTRA = MSG.EXTRA || null;

  // Full, loss-less map of every reported measurement, keyed by Datakom's field
  // name (N): { value:number|null, raw:<original string>, unit, addr }.
  const values = {};
  for (const it of VALUE) {
    if (it && it.N) values[it.N] = { value: num(it.V), raw: it.V, unit: it.U ?? null, addr: it.A ?? null };
  }
  const byName = (name) => values[name] || null;
  const numOf  = (name) => (values[name] ? values[name].value : null);
  const strOf  = (name) => (values[name] ? values[name].raw : null);

  return {
    did,
    slx: Number(msg.slx),
    // rcvt/errt are in 1/10 s in the wire format; ×10 → seconds (per the C# client).
    receivedAtSec: Number(msg.rcvt) * 10 || null,
    lastErrorAtSec: Number(msg.errt) * 10 || null,
    // Curated key metrics — CONFIRMED against a real D-series device's live frame.
    metrics: {
      fuelLevel:   byName('Engine Fuel Level'),
      battery:     byName('Engine Battery Voltage1'),
      coolantTemp: byName('Engine Coolant Temp'),
      oilPressure: byName('Engine Oil Pressure'),
      rpm:         byName('Engine RPM'),
      runHours:    byName('Engine Run Hours'),
      gensetFreq:  byName('Genset Freq'),
      gensetPower: byName('Genset Tot Active Pwr'),
      mainsL1:     byName('Mains L1'),
    },
    gps: {
      lat:  numOf('Information Latitude'),
      lng:  numOf('Information Longitude'),
      sats: numOf('Information Satellite(s)'),
    },
    identity: {
      siteId:      strOf('Information SITE-ID'),
      gensetState: strOf('Genset State'),
      gensetMode:  strOf('Genset Mode'),
      swVersion:   strOf('Information SW Version'),
      deviceType:  strOf('Information Device Type'),
    },
    // IP the device reports over the cloud (if any) — used to auto-fill the
    // platform device's IP so it can also be reached over Modbus/IP.
    ip: extractIp(values),
    alarms: EXTRA && EXTRA.Alarm ? EXTRA.Alarm : null,  // { ShutDown:[], LoadDump:[], Warning:[] }
    values,
    readAt: new Date().toISOString(),
    raw: msg,
  };
}

// ── Send helpers ──────────────────────────────────────────────────────────────
function sendJson(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

// The login frame needs `Random` as a bare 18-digit integer (a JS number would
// lose precision), so serialize with a placeholder and splice the BigInt in.
function sendLogin(rndNum) {
  const msgPrm = CFG.push === 1 ? 'JSON' : CFG.push === 2 ? 'DATA' : 'NONE';
  const obj = {
    Request: 'usr_login',
    UsrNam: CFG.user,
    UsrPwd: CFG.pass,
    ComIdt: -1,
    AppMod: 'V',
    MsgPrm: msgPrm,
    Random: '@@RANDOM@@',
    RndNum: rndNum,
  };
  const payload = JSON.stringify(obj).replace('"@@RANDOM@@"', dotNetTodayTicks().toString());
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(payload); return true; }
  return false;
}

function requestNodeDevices(node, skip) {
  sendJson({ Request: 'devx_list', Node: node, Skip: skip });
}

// Walk to the next node in the tree; when every node is paged, prime the pump.
function advanceDevxWalk() {
  if (nodeCursor < nodes.length) {
    requestNodeDevices(nodes[nodeCursor].id, 0);
  } else {
    sendJson({ Request: 'devx_pump', job: 1 });
  }
}

// Re-prime the live subscription. In JSON-PUSH mode the server streams
// dump_devm/dump_gway frames on its own once the pump is primed; re-sending
// devx_pump on a cadence refreshes the subscription and doubles as a keepalive.
function reprimePump() {
  sendJson({ Request: 'devx_pump', job: 1 });
}

// ── Message handling ──────────────────────────────────────────────────────────
function rememberFrame(frame) {
  recentFrames.push({ at: new Date().toISOString(), frame });
  if (recentFrames.length > MAX_RECENT) recentFrames.shift();
}

function handleMessage(buf) {
  let msg;
  try { msg = JSON.parse(buf.toString()); } catch (_) { return; }
  rememberFrame(msg);

  switch (msg.Request) {
    // 1) Challenge → solve → log in.
    case 'usr_fedai': {
      const answer = solveFedai(msg.fedai);
      if (CFG.verbose) console.log(`[Datakom] Fedai challenge → RndNum=${answer}`);
      sendLogin(answer);
      return;
    }

    // 2) Login response. Access>=1 means accepted.
    case 'usr_login': {
      const access = Number(msg.Access);
      if (!(access >= 1)) {
        lastError = `login rejected (Access=${msg.Access})`;
        console.error(`[Datakom] ✗ Login rejected — check DK_USER/DK_PASS (Access=${msg.Access})`);
        // A rejected login must keep the failure backoff — don't reset counters.
        try { ws.close(); } catch (_) {}
        return;
      }
      session = { Access: access, ComNam: msg.ComNam ?? null };
      ready = true;
      lastError = null;
      // Only a SUCCESSFUL login resets the backoff/failure counters.
      reconnectDelay = RECONNECT_MIN_MS;
      failedCycles = 0;
      console.log(`[Datakom] ✓ Logged in (Access=${access})`);
      // The server pushes node_list next on its own; nothing to send here.
      return;
    }

    // 3) Device tree. Kick off the per-node devx_list walk.
    case 'node_list': {
      nodes = Array.isArray(msg.NodeList)
        ? msg.NodeList.map((n) => ({ id: Number(n.id), parent: Number(n.parent), name: n.name }))
        : [];
      nodeCursor = 0;
      if (CFG.verbose) console.log(`[Datakom] Node list: ${nodes.length} node(s)`);
      advanceDevxWalk();
      return;
    }

    // 4) Device list page. Accumulate, then page or advance.
    case 'devx_list': {
      const list = Array.isArray(msg.DevxList) ? msg.DevxList : [];
      for (const d of list) {
        const did = Number(d.did);
        if (!Number.isFinite(did)) continue;
        const entry = {
          did,
          sid: d.sid ?? null,
          esn: d.esn ?? null,
          lat: d.lat ?? null,
          lng: d.lng ?? null,
          node: Number(msg.Node),
          ...d,
        };
        devicesById.set(did, entry);
        if (d.sid) nameToId.set(norm(d.sid), did);
      }
      if (Number(msg.Last) < 1) {
        // More pages for THIS node — ask for the next slice.
        requestNodeDevices(Number(msg.Node), devicesForNode(Number(msg.Node)));
      } else {
        // This node is done — move to the next one.
        nodeCursor += 1;
        advanceDevxWalk();
      }
      return;
    }

    // 5) Pump acknowledgement (job>=2). The device list is ready — now actively
    //    poll each device's values, and keep polling on a cadence for live data.
    case 'devx_pump': {
      if (Number(msg.job) >= 2) {
        if (CFG.verbose) console.log(`[Datakom] Pump primed — live push active for ${devicesById.size} device(s)`);
        if (repumpTimer) clearInterval(repumpTimer);
        repumpTimer = setInterval(reprimePump, REPUMP_MS);
      }
      return;
    }

    // 6) Live readings.
    case 'dump_devm':
    case 'dump_gway': {
      const reading = parseReading(msg);
      if (reading) readingsById.set(reading.did, reading);
      return;
    }

    default:
      return;  // ignore anything else
  }
}

function devicesForNode(node) {
  let n = 0;
  for (const d of devicesById.values()) if (d.node === node) n += 1;
  return n;
}

// ── Connection lifecycle ─────────────────────────────────────────────────────
function connect() {
  if (CFG.verbose) console.log(`[Datakom] Connecting → ${CFG.url}`);
  ws = new WebSocket(CFG.url, {
    handshakeTimeout: 10_000,
    rejectUnauthorized: !CFG.insecure,
  });

  ws.on('open', () => {
    connectedAt = new Date().toISOString();
    lastError = null;
    if (CFG.verbose) console.log('[Datakom] Socket open — awaiting fedai challenge…');
  });

  ws.on('message', handleMessage);

  ws.on('close', (code) => {
    const wasReady = ready;
    ready = false;
    if (repumpTimer) { clearInterval(repumpTimer); repumpTimer = null; }

    // Explicit stop(): don't count a failure, don't reconnect.
    if (stopped) return;

    if (wasReady) failedCycles = 0; else failedCycles += 1;

    if (failedCycles >= MAX_FAILED_CYCLES) {
      gaveUp = true;
      console.error(
        `[Datakom] Stopped after ${failedCycles} failed attempts with no successful login ` +
        `(last close code ${code}). NOT reconnecting — port 464 is IP-allowlisted by Datakom, ` +
        `so an ECONNRESET here usually means this host's public IP is not whitelisted. ` +
        `Confirm the IP is whitelisted, then restart to retry.`
      );
      return;
    }

    if (CFG.verbose) console.warn(`[Datakom] Socket closed (code ${code}) — reconnecting in ${reconnectDelay / 1000}s (failure #${failedCycles})`);
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    lastError = err.message;
    if (CFG.verbose) console.warn(`[Datakom] Socket error: ${err.message}`);
    // 'close' fires after 'error' and schedules the reconnect / give-up.
  });
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (isEnabled() && !gaveUp && !stopped) connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

// ── Public read-only surface (consumed by the brand-adapter registry) ────────
// start() is called once at boot AND manually from the adapter control API.
// A manual start always clears gaveUp/stopped and resets the backoff, so a
// "gave up after 8 failures" state is recoverable without a process restart.
function start() {
  if (!isEnabled()) {
    console.log('[Datakom] Adapter is disabled (DK_ENABLED / runtime setting) — not starting.');
    return;
  }
  if (!CFG.user || !CFG.pass) {
    console.warn('[Datakom] DK_USER / DK_PASS not set — cannot start Datakom adapter.');
    return;
  }
  // Already connected/connecting with a live socket — idempotent no-op.
  if (starting && ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  stopped = false;
  gaveUp = false;
  failedCycles = 0;
  reconnectDelay = RECONNECT_MIN_MS;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  starting = true;
  connect();
}

// Stop the adapter: close the socket and cancel every pending timer so nothing
// resurrects the connection. Last-known devices/readings stay in memory so the
// UI keeps showing the final snapshot (marked not-ready).
function stop() {
  stopped = true;
  starting = false;
  ready = false;
  session = null;
  if (repumpTimer)    { clearInterval(repumpTimer);   repumpTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
  console.log('[Datakom] Adapter stopped (manual).');
}

// Runtime enable/disable override on top of env DK_ENABLED (null = follow env).
// Does NOT itself start/stop the socket — callers pair it with start()/stop().
function setEnabled(v) {
  enabledOverride = v == null ? null : !!v;
}

function isReady() { return ready; }

function getStatus() {
  return {
    brand:       'datakom',
    enabled:     isEnabled(),
    enabledSource: enabledOverride != null ? 'runtime' : 'env',
    url:         CFG.url,
    push:        CFG.push,
    ready,
    stopped,
    gaveUp,
    connectedAt,
    lastError,
    failedCycles,
    nodes:       nodes.length,
    deviceCount: devicesById.size,
    readingCount: readingsById.size,
    session,
    recentFrames,                       // raw frames, for finishing the field mapping
  };
}

function listDevices() {
  return Array.from(devicesById.values()).map((d) => ({
    ...d,
    reading: readingsById.get(d.did) || null,
  }));
}

// Accept either a Datakom device id (did) or a device name/sid.
function getReading(idOrName) {
  let did = Number(idOrName);
  if (!Number.isFinite(did)) did = nameToId.get(norm(idOrName));
  if (!Number.isFinite(did)) return null;
  return {
    device:  devicesById.get(did) || null,
    reading: readingsById.get(did) || null,
  };
}

// ── Node tree (read-only "project tree") ─────────────────────────────────────
// Datakom groups devices under a node hierarchy: node_list gives {id,parent,name}
// and every device is tagged with the node it belongs to. getTree() returns that
// hierarchy nested, with each node's devices (plus a light live summary) attached
// — the shape the Projects page renders as a read-only "Datakom Rainbow" tree.

// A compact, display-oriented view of one device: identity + just enough live
// state (online / fuel% / alarm count) for the tree, without the full values map.
function summarizeDevice(d) {
  const reading = readingsById.get(d.did) || null;
  const fm = reading && reading.metrics ? reading.metrics.fuelLevel : null;
  // Only trust a fuel value that is a percentage (matches the gauges' %-scale).
  const fuel =
    fm && fm.value != null && (fm.unit == null || /%/.test(String(fm.unit))) ? fm.value : null;
  let alarmCount = 0;
  const al = reading ? reading.alarms : null;
  if (al) for (const k of ['ShutDown', 'LoadDump', 'Warning']) {
    if (Array.isArray(al[k])) alarmCount += al[k].length;
  }
  return {
    did:       d.did,
    sid:       d.sid ?? null,
    esn:       d.esn ?? null,
    lat:       d.lat ?? null,
    lng:       d.lng ?? null,
    node:      d.node ?? null,
    online:    !!reading,
    fuel,
    alarmCount,
    ip:        reading ? reading.ip : null,   // IP the device reports over the cloud, if any
    readAt:    reading ? reading.readAt : null,
  };
}

function getTree() {
  // Fresh node objects so we can nest without mutating module state.
  const byId = new Map();
  for (const n of nodes) {
    byId.set(n.id, { id: n.id, name: n.name ?? `Node ${n.id}`, parent: n.parent, children: [], devices: [] });
  }

  // Attach each device to its node; anything whose node is unknown is "ungrouped".
  const ungrouped = [];
  for (const d of devicesById.values()) {
    const bucket = byId.get(d.node);
    if (bucket) bucket.devices.push(summarizeDevice(d));
    else ungrouped.push(summarizeDevice(d));
  }

  // Nest by parent. A node whose parent is missing (or is itself) becomes a root.
  const roots = [];
  for (const node of byId.values()) {
    const parent = node.parent != null ? byId.get(node.parent) : null;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }

  return {
    brand:       'datakom',
    ready,
    nodeCount:   nodes.length,
    deviceCount: devicesById.size,
    roots,
    ungrouped,
  };
}

// ── Remote control (start/stop) — SCAFFOLD ────────────────────────────────────
// Datakom's Rainbow cloud protocol is read-only in every reference we have, so the
// exact command frame for remote genset start/stop is NOT yet known. Everything
// around the command is implemented here (action validation, device resolution,
// socket check, send). The ONLY missing piece is the wire format, which must be
// captured from a real portal session (browser DevTools → WS → Messages, press
// Start/Stop) and returned from buildControlFrame() below. Until then sendControl
// refuses with CONTROL_NOT_CONFIGURED, so we never transmit a guessed frame.

const CONTROL_ACTIONS = new Set(['start', 'stop']);

/**
 * Build the exact JSON frame to send for a control action, or return null if the
 * wire format hasn't been configured yet.
 *
 * TODO(datakom-control): replace the body with the REAL captured frames. Example
 * shape only (the actual Request name / fields are unknown until captured):
 *   if (action === 'start') return { Request: 'devx_ctrl', did, Cmd: <START_CODE> };
 *   if (action === 'stop')  return { Request: 'devx_ctrl', did, Cmd: <STOP_CODE>  };
 * Whatever this returns is sent verbatim by sendControl().
 */
function buildControlFrame(/* action, did */) {
  return null; // ← inert until configured
}

/**
 * Send a remote control command to a Datakom device.
 * @param {number|string} idOrName  Datakom device id (did) or name/sid
 * @param {'start'|'stop'} action
 * @returns {Promise<{ok:boolean, code?:string, error?:string, did?:number, action?:string, sentAt?:string}>}
 */
async function sendControl(idOrName, action) {
  const act = String(action || '').toLowerCase();
  if (!CONTROL_ACTIONS.has(act)) {
    return { ok: false, code: 'BAD_ACTION', error: `unsupported action '${action}' (expected start|stop)` };
  }

  let did = Number(idOrName);
  if (!Number.isFinite(did)) did = nameToId.get(norm(idOrName));
  if (!Number.isFinite(did)) {
    return { ok: false, code: 'UNKNOWN_DEVICE', error: `unknown Datakom device '${idOrName}'` };
  }

  if (!ready || !ws || ws.readyState !== WebSocket.OPEN) {
    return { ok: false, code: 'NOT_CONNECTED', error: 'Datakom adapter is not connected' };
  }

  const frame = buildControlFrame(act, did);
  if (!frame) {
    return {
      ok: false,
      code: 'CONTROL_NOT_CONFIGURED',
      error: 'Datakom cloud control is not configured yet — the Rainbow remote start/stop ' +
             'command frame is unknown. Capture it from the portal (DevTools → WS → Messages) ' +
             'and fill in buildControlFrame() in datakom-rainbow.js.',
    };
  }

  const sent = sendJson(frame);
  if (!sent) return { ok: false, code: 'SEND_FAILED', error: 'failed to send — socket not open' };
  console.log(`[Datakom] Control '${act}' sent to did ${did}`);
  return { ok: true, did, action: act, sentAt: new Date().toISOString() };
}

// Returns the Set of Datakom device ids (did) that currently have a live reading.
// Used by index.js to reconcile device status for Rainbow-connected devices.
function connectedDids() {
  if (!ready) return new Set();
  return new Set(readingsById.keys());
}

module.exports = { start, stop, setEnabled, isReady, getStatus, listDevices, getReading, getTree, sendControl, connectedDids };
