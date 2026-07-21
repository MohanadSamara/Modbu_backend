/**
 * device-io.js  (SERVER SIDE)
 *
 * Thin routing facade over the two ways the server can reach a device:
 *   - REMOTE: device is served by a site agent over the reverse tunnel
 *     (remote-hub.js) — used when isRemote(deviceId) is true.
 *   - LOCAL:  direct Modbus TCP from this server (modbus_connect.js) — the
 *     original path, used for devices on a network this server can reach and
 *     for manual ip:port connects.
 *
 * It re-exports the exact same function surface as modbus_connect.js, so
 * index.js only swaps its import from './modbus_connect' to './device-io' and
 * nothing else changes. A device transparently becomes "remote" the moment its
 * agent connects, and falls back to local TCP if no agent is present.
 */

const local  = require('./modbus_connect');
const remote = require('./remote-hub');

const remoteId = (target) => {
  const id = target && target.deviceId != null ? Number(target.deviceId) : null;
  return id != null && remote.isRemote(id) ? id : null;
};

async function connectModbus(deviceId = null, ip = null, port = null) {
  if (deviceId != null && remote.isRemote(deviceId)) return remote.connect(deviceId);
  return local.connectModbus(deviceId, ip, port);
}

async function disconnectModbus(target = {}) {
  const id = remoteId(target);
  if (id != null) return remote.disconnect(id);
  return local.disconnectModbus(target);
}

async function readFuel(target = {}) {
  const id = remoteId(target);
  if (id != null) return remote.readFuel(id);
  return local.readFuel(target);
}

async function readGps(target = {}) {
  const id = remoteId(target);
  if (id != null) return remote.readGps(id);
  return local.readGps(target);
}

async function readRegisters(target = {}, start, count = 1) {
  const id = remoteId(target);
  if (id != null) return remote.readRegisters(id, start, count);
  return local.readRegisters(target, start, count);
}

async function readTelemetry(target = {}) {
  const id = remoteId(target);
  if (id != null) return remote.readTelemetry(id);
  return local.readTelemetry(target);
}

async function startButton(target = {}) {
  const id = remoteId(target);
  if (id != null) return remote.startButton(id);
  return local.startButton(target);
}

async function stopButton(target = {}) {
  const id = remoteId(target);
  if (id != null) return remote.stopButton(id);
  return local.stopButton(target);
}

function isConnected(target = {}) {
  const id = remoteId(target);
  if (id != null) return remote.isConnected(id);
  return local.isConnected(target);
}

// Merge local hubs + remote (agent-served) devices into the one session shape.
function getSession() {
  const s = local.getSession();
  const remoteDevices = remote.session();
  // A device that is both in the DB and served by an agent should appear once —
  // prefer the remote entry (it reflects the live tunnel state).
  const remoteIds = new Set(remoteDevices.map((d) => d.deviceId));
  const localDevices = s.devices.filter((d) => d.deviceId == null || !remoteIds.has(Number(d.deviceId)));
  const merged = [...localDevices, ...remoteDevices];
  const firstConnected = merged.find((d) => d.connected) || null;
  return {
    connected: merged.some((d) => d.connected),
    deviceId: firstConnected?.deviceId ?? null,
    devices: merged,
  };
}

// Pure DB/config + shutdown pass straight through to the local module.
const getDeviceConfig = local.getDeviceConfig;
async function closeAll() { return local.closeAll(); }

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
