'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ops = require('../shared/modbus-registers');

// Minimal fake modbus-serial client. Records writes and serves canned reads
// keyed by start register so we can assert the register map without hardware.
function makeClient(readMap = {}) {
  return {
    writes: [],
    async readHoldingRegisters(start, count) {
      const entry = readMap[start];
      if (!entry) throw new Error(`unexpected read @${start}`);
      const data = entry.slice(0, count);
      // Build a big-endian word buffer to mirror the real library's res.buffer.
      const buf = Buffer.alloc(data.length * 2);
      data.forEach((v, i) => buf.writeUInt16BE(v & 0xffff, i * 2));
      return { data, buffer: buf };
    },
    async writeRegister(addr, value) {
      this.writes.push([addr, value]);
    },
  };
}

test('readFuel: scales raw register by 1/10', async () => {
  const client = makeClient({ 10363: [937] });
  assert.equal(await ops.readFuel(client), 93.7);
});

test('readFuel: unavailable-sensor sentinel (0x7FFF) reads as null, not 3276.7%', async () => {
  const client = makeClient({ 10363: [0x7fff] });
  assert.equal(await ops.readFuel(client), null);
});

test('decodeFuel: rejects sentinels and out-of-range, clamps slack, passes valid', () => {
  // Rail/sentinel values → no usable reading.
  assert.equal(ops.decodeFuel(0x7fff), null); // 32767
  assert.equal(ops.decodeFuel(0x8000), null); // -32768
  assert.equal(ops.decodeFuel(0xffff), null); // -1 raw / all-ones
  assert.equal(ops.decodeFuel(null), null);
  // Wildly out of the 0–100% band is a fault reading.
  assert.equal(ops.decodeFuel(5000), null);   // 500%
  // Small calibration slack is clamped into range rather than rejected.
  assert.equal(ops.decodeFuel(1005), 100);    // 100.5% → 100
  // Normal readings pass through, scaled by 1/10.
  assert.equal(ops.decodeFuel(0), 0);
  assert.equal(ops.decodeFuel(500), 50);
  assert.equal(ops.decodeFuel(1000), 100);
});

test('readGps: decodes 3 big-endian int32 values and divisor', async () => {
  // lat = 31.5°, lon = 34.75° in micro-degrees; alt = 120 m.
  const lat = Math.round(31.5 * 1_000_000);   // 31500000
  const lon = Math.round(34.75 * 1_000_000);  // 34750000
  const alt = 120;
  const words = [];
  for (const n of [lat, lon, alt]) {
    words.push((n >>> 16) & 0xffff, n & 0xffff); // high word first
  }
  const client = makeClient({ 10594: words });
  const gps = await ops.readGps(client);
  assert.equal(gps.latitude, 31.5);
  assert.equal(gps.longitude, 34.75);
  assert.equal(gps.altitude, 120);
  assert.equal(gps.hasFix, true);
  assert.equal(gps.valid, true);
});

test('readGps: 0/0 is treated as no fix', async () => {
  const client = makeClient({ 10594: [0, 0, 0, 0, 0, 0] });
  const gps = await ops.readGps(client);
  assert.equal(gps.hasFix, false);
});

test('readRegisters: returns raw values + hex, clamps count', async () => {
  const client = makeClient({ 8193: [1, 2, 3] });
  const r = await ops.readRegisters(client, 8193, 3);
  assert.deepEqual(r.values, [1, 2, 3]);
  assert.deepEqual(r.hex, ['0x0001', '0x0002', '0x0003']);
  assert.equal(r.start, 8193);
  assert.equal(r.count, 3);
});

test('readRegisters: rejects an invalid start register', async () => {
  const client = makeClient({});
  await assert.rejects(() => ops.readRegisters(client, -5, 1), /Invalid start register/);
});

test('readEngine: decodes the ÷10 block, RPM (x1) and battery (÷100)', async () => {
  const client = makeClient({
    // 10361..10366: oilPress, engineTemp, fuel, oilTemp, canopyTemp, ambientTemp
    10361: [45, 812, 623, 700, 350, 251],
    10376: [1503],   // RPM ×1
    10385: [1247],   // battery ÷100 = 12.47 V
  });
  const e = await ops.readEngine(client);
  assert.equal(e.oilPressure, 4.5);
  assert.equal(e.engineTemp, 81.2);
  assert.equal(e.fuel, 62.3);
  assert.equal(e.oilTemp, 70);
  assert.equal(e.canopyTemp, 35);
  assert.equal(e.ambientTemp, 25.1);
  assert.equal(e.rpm, 1503);
  assert.equal(e.batteryVoltage, 12.47);
});

test('readEngine: negative temperatures decode as signed 16-bit', async () => {
  // -5.0 °C ambient = raw -50 = 0xFFCE as an unsigned word.
  const client = makeClient({
    10361: [0, 0, 0, 0, 0, 0xFFCE],
    10376: [0],
    10385: [0],
  });
  const e = await ops.readEngine(client);
  assert.equal(e.ambientTemp, -5);
});

test('readTelemetry: combines engine block + gps', async () => {
  const client = makeClient({
    10361: [0, 0, 500, 0, 0, 0], // fuel = 50%
    10376: [0],
    10385: [0],
    10594: [0, 0, 0, 0, 0, 0],
  });
  const t = await ops.readTelemetry(client);
  assert.equal(t.fuel, 50);
  assert.equal(t.gps.hasFix, false);
  assert.ok(t.readAt);
});

test('stop: writes 1 to the control register', async () => {
  const client = makeClient({});
  assert.equal(await ops.stop(client), true);
  assert.deepEqual(client.writes, [[8193, 1]]);
});

test('start: presses (8) then releases (0) the control register', async () => {
  const client = makeClient({});
  assert.equal(await ops.start(client), true);
  assert.deepEqual(client.writes, [[8193, 8], [8193, 0]]);
});
