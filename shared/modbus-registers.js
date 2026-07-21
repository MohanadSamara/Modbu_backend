/**
 * shared/modbus-registers.js
 *
 * Datakom D-300 / D-500 / D-700 Modbus register map + read/write helpers.
 * (Register numbers per the "D-300/500/700 Modbus Application Manual" 500_MODBUS.pdf.)
 *
 * PURE MODULE — no external dependencies, no DB. It only operates on a
 * modbus-serial client instance passed in by the caller. This lets BOTH the
 * central server and the remote site agent share one authoritative copy of the
 * register logic so the two can never drift (same fuel scale, same GPS decode).
 *
 * Function 3 (read holding registers) and Function 6 (write single register)
 * are the only functions the D-series supports.
 */

const REG = {
  CONTROL:  8193,   // start/stop control register (write single — pushbutton sim)
  // Engine/analog block — 6 CONTIGUOUS 16-bit registers, all coefficient ÷10.
  // (Manual p.13: 10361 oil pressure, 10362 engine temp, 10363 fuel, 10364 oil
  // temp, 10365 canopy temp, 10366 ambient temp.) Reading the whole block in one
  // request is cheaper than 6 separate reads.
  ENGINE_BASE:  10361,
  OIL_PRESSURE: 10361,  // bar   (÷10)
  ENGINE_TEMP:  10362,  // °C    (÷10)
  FUEL:         10363,  // %     (÷10)
  OIL_TEMP:     10364,  // °C    (÷10)
  CANOPY_TEMP:  10365,  // °C    (÷10)
  AMBIENT_TEMP: 10366,  // °C    (÷10)
  RPM:          10376,  // engine rpm (×1, raw)
  BATTERY:      10385,  // min battery voltage during cranking (÷100)
  GPS_BASE:     10594,  // 6 registers: lat[2], lon[2], alt[2] — 32-bit, high word first
};

// Raw GPS integers are micro-degrees (the most common GPS-over-Modbus encoding;
// Datakom does not document the coefficient). If a real device reports a
// position that is off, recalibrate against latitudeRaw/longitudeRaw.
const GPS_DIVISOR = 1_000_000;

// The engine block registers are signed 16-bit (ambient/oil temps can be
// negative). modbus-serial hands back unsigned words, so re-interpret here.
function toSigned16(v) {
  return v > 0x7fff ? v - 0x10000 : v;
}

// Fuel level (reg 10363) is a signed 16-bit value, coefficient ÷10, meaning a
// 0–100 % tank reading. When the sensor is unplugged or the reading is out of
// range the D-series parks the register at a rail value (0x7FFF / 0x8000 /
// 0xFFFF); naively dividing 0x7FFF by 10 yields a nonsense 3276.7 % that the UI
// would happily render as "Good". Decode + validate in one place so every caller
// (server, agent, telemetry) rejects a bad reading identically. Returns a clamped
// 0–100 percentage, or null when the register carries no usable value.
function decodeFuel(raw) {
  if (raw == null || raw === 0x7fff || raw === 0x8000 || raw === 0xffff) return null;
  const pct = toSigned16(raw) / 10;
  // Allow a little slack for sensor calibration, then clamp to the real range.
  // Anything wildly outside 0–100 % is a fault reading, not a fuel level.
  if (!Number.isFinite(pct) || pct < -1 || pct > 110) return null;
  return Math.max(0, Math.min(100, pct));
}

// ── Reads ────────────────────────────────────────────────────────────────────
async function readFuel(client) {
  const res = await client.readHoldingRegisters(REG.FUEL, 1);
  return decodeFuel(res.data[0]);
}

async function readGps(client) {
  const res = await client.readHoldingRegisters(REG.GPS_BASE, 6);
  const buf = res.buffer; // 12 bytes, big-endian words
  const latRaw = buf.readInt32BE(0);
  const lonRaw = buf.readInt32BE(4);
  const altRaw = buf.readInt32BE(8);

  const latitude  = latRaw / GPS_DIVISOR;
  const longitude = lonRaw / GPS_DIVISOR;
  const altitude  = altRaw; // metres (no documented coefficient)

  // No GPS fix usually reports 0/0 — treat that as "no fix" rather than
  // plotting a marker in the Gulf of Guinea.
  const hasFix = latRaw !== 0 || lonRaw !== 0;
  const valid  = Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;

  return {
    latitude, longitude, altitude,
    latitudeRaw: latRaw, longitudeRaw: lonRaw, altitudeRaw: altRaw,
    hasFix, valid,
  };
}

// Read an arbitrary block of holding registers (Modbus function 3). Returns the
// raw 16-bit values plus the big-endian word buffer so callers can decode 32-bit
// quantities themselves. `start` is the register number, `count` the number of
// consecutive registers (1–125, the Modbus per-request limit).
async function readRegisters(client, start, count = 1) {
  const s = Number(start);
  const n = Math.max(1, Math.min(Number(count) || 1, 125));
  if (!Number.isInteger(s) || s < 0) throw new Error(`Invalid start register: ${start}`);
  const res = await client.readHoldingRegisters(s, n);
  return {
    start: s,
    count: n,
    values: Array.from(res.data),
    hex: Array.from(res.data).map((v) => '0x' + v.toString(16).padStart(4, '0')),
  };
}

// Read the engine/analog block plus RPM and battery voltage. All documented on
// manual p.13. Values are decoded with their documented coefficients. Fuel comes
// out of this same block (10363), so callers get it for free here.
async function readEngine(client) {
  // One request for the 6 contiguous ÷10 registers (10361–10366).
  const block = await client.readHoldingRegisters(REG.ENGINE_BASE, 6);
  const d = block.data;
  const engine = {
    oilPressure: toSigned16(d[0]) / 10, // bar
    engineTemp:  toSigned16(d[1]) / 10, // °C
    fuel:        decodeFuel(d[2]),      // % (validated: null when out of range)
    oilTemp:     toSigned16(d[3]) / 10, // °C
    canopyTemp:  toSigned16(d[4]) / 10, // °C
    ambientTemp: toSigned16(d[5]) / 10, // °C
  };

  // RPM (×1) and cranking battery voltage (÷100) are separate registers.
  const rpmRes  = await client.readHoldingRegisters(REG.RPM, 1);
  const battRes = await client.readHoldingRegisters(REG.BATTERY, 1);
  engine.rpm            = rpmRes.data[0];
  engine.batteryVoltage = battRes.data[0] / 100;

  return engine;
}

// Read every documented live value in one snapshot: the engine block (incl.
// fuel), RPM, battery, and GPS. Reads are sequential (NOT Promise.all) because
// Modbus TCP is one request/response socket — concurrent requests would
// interleave transaction ids on the same client.
async function readTelemetry(client) {
  const engine = await readEngine(client);
  const gps    = await readGps(client);
  return { ...engine, gps, readAt: new Date().toISOString() };
}

// ── Writes (controls) ────────────────────────────────────────────────────────
// STOP: reg 8193 = 1
async function stop(client) {
  await client.writeRegister(REG.CONTROL, 1);
  return true;
}

// START: reg 8193 press (8) then release (0), matching the physical button.
async function start(client) {
  await client.writeRegister(REG.CONTROL, 8);
  await new Promise((r) => setTimeout(r, 100));
  await client.writeRegister(REG.CONTROL, 0);
  return true;
}

module.exports = {
  REG, GPS_DIVISOR, toSigned16, decodeFuel,
  readFuel, readGps, readEngine, readRegisters, readTelemetry,
  start, stop,
};
