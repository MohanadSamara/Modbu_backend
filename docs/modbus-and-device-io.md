# Device I/O — Modbus & live telemetry

This is the platform's **primary, control-capable** device channel: a direct Modbus TCP
connection to each generator. (The Datakom cloud channel is separate and read-only —
[datakom.md](datakom.md).)

Three pieces:

- **`modbus_connect.js`** — the connection engine (sockets, locking, reconnect) + operations.
- **`shared/modbus-registers.js`** — the pure register map + decode/encode (shared, so the
  server can never drift from any other consumer of the same registers).
- **`telemetry-ws.js`** — pushes fresh readings to browsers over a WebSocket.

---

## The connection engine (`modbus_connect.js`)

### Per-device "hubs"

Every device gets its own **hub** — an object holding a `modbus-serial` client, connection
state, and a per-device request lock. Hubs live in a `Map` keyed by:

- `d:<deviceId>` for DB devices, or
- `m:<ip>:<port>` for manual/ad-hoc connects.

Why per-device (not one global client): with a single shared client, a second user connecting
would repoint the socket and reads/**Start/Stop** could hit the *wrong physical device*. With
hubs:

- two users on the **same** device share that device's one socket (Modbus TCP slaves usually
  allow a single connection);
- two users on **different** devices get independent sockets;
- all ops on a device are **serialized through its lock** so requests never interleave on the
  one socket.

Key internals:

| Function | Role |
|---|---|
| `hubKey(target)` / `getOrCreateHub` | Derive the map key, create/update the hub. |
| `resolveHub(target)` | Find the hub for a request (falls back to the sole hub for legacy single-device callers). |
| `withLock(hub, fn)` | Chain `fn` onto the hub's promise-based mutex; the chain never rejects. |
| `attachSocketListeners(hub)` | On socket `close`/`error`, mark disconnected and schedule reconnect. |
| `scheduleReconnect` / `cancelReconnect` | Auto-retry a dropped hub every `RECONNECT_INTERVAL_MS` (10 s) when `autoReconnect` is on. |
| `getTimeoutMs()` | Read/request timeout from the `CONNECTION_TIMEOUT` system setting (cached 5 min). |
| `getDeviceConfig(deviceId)` | Resolve a device's IP/port/name/unit from the `devices` row. |
| `rawConnect(hub)` | The actual TCP connect (handshake bounded to `CONNECT_TIMEOUT_CEILING` = 8 s so a dead device fails fast, independent of the admin's read timeout). |

Env defaults: `MODBUS_IP` (`192.168.1.20`), `MODBUS_PORT` (`502`), request timeout `5000` ms.

### Public operations

Each takes a `target` (`{ deviceId?, ip?, port? }`). Backed by the shared register helpers:

| Op | Registers touched | Notes |
|---|---|---|
| `connectModbus(deviceId, ipOverride?, portOverride?)` | — | Open/attach the hub. |
| `disconnectModbus(target)` / `closeAll()` | — | Close one / all hubs. |
| `isConnected(target)` / `getSession()` | — | State for `/api/modbus/session`. |
| `readFuel(target)` | 10363 | Validated fuel % (see decoding below). |
| `readGps(target)` | 10594 ×6 | lat/lon/alt, with fix + validity flags. |
| `readRegisters(target, start, count)` | arbitrary | Raw holding-register block read. |
| `readTelemetry(target)` | 10361–10366, 10376, 10385, GPS | Full snapshot. |
| `startButton(target)` | 8193 | Pushbutton-simulated start. |
| `stopButton(target)` | 8193 | Stop. |

---

## Register map (`shared/modbus-registers.js`)

Datakom **D-300 / D-500 / D-700** register map (per the "500_MODBUS.pdf" manual). A **pure
module** — no DB, no side effects; it only operates on a passed-in `modbus-serial` client, so
any consumer shares one authoritative copy (same fuel scale, same GPS decode). Only Modbus
**function 3** (read holding registers) and **function 6** (write single register) are used.

| Register | Meaning | Decode |
|---|---|---|
| `8193` | Start/Stop control | write: STOP = `1`; START = press `8`, wait 100 ms, release `0` |
| `10361` | Oil pressure (bar) | signed ÷10 |
| `10362` | Engine temp (°C) | signed ÷10 |
| `10363` | **Fuel (%)** | signed ÷10, validated |
| `10364` | Oil temp (°C) | signed ÷10 |
| `10365` | Canopy temp (°C) | signed ÷10 |
| `10366` | Ambient temp (°C) | signed ÷10 |
| `10376` | Engine RPM | raw ×1 |
| `10385` | Cranking battery voltage | ÷100 |
| `10594` ×6 | GPS lat[2], lon[2], alt[2] | 32-bit big-endian; lat/lon ÷1 000 000 (µ°) |

**Fuel validation (`decodeFuel`)** — the D-series parks the register at a rail value
(`0x7FFF` / `0x8000` / `0xFFFF`) when the sensor is unplugged or out of range; naively
dividing `0x7FFF` by 10 yields a nonsense `3276.7%` that a gauge would render as "Good".
`decodeFuel` rejects the rails, interprets the value as signed, rejects anything outside
`-1..110`, and clamps the rest to `0..100` — returning `null` for an unusable reading. Every
caller (server, telemetry) rejects a bad reading identically.

**GPS (`readGps`)** — treats `0/0` as "no fix" (rather than plotting a marker in the Gulf of
Guinea) and flags positions outside ±90/±180 as invalid.

`readTelemetry` reads sequentially (not `Promise.all`) because Modbus TCP is a single
request/response socket — concurrent requests would collide transaction ids.

## Derived metrics (`lib/telemetry-math.js`)

| Function | Purpose |
|---|---|
| `computeConsumption(samples, minSamples)` | Fuel consumption rate from a series of readings. |
| `bucketEvents(events, opts)` | Group events into time buckets for charts. |
| `describeAlarm(actionType)` | Human-readable alarm description. |

The fuel-poll path in `index.js` reads fuel, persists a `device_readings` row, evaluates
thresholds (raising an `alarms` row when breached, unless snoozed via `device_snoozes`), and
calls `broadcastTelemetry`.

---

## Live telemetry WebSocket (`telemetry-ws.js`)

So the dashboard gets real-time updates instead of polling `/api/modbus/fuel` on a timer.

- **Path:** `/ws/telemetry`, attached to the HTTP server after `app.listen`.
- **Auth:** browsers can't set an `Authorization` header on a WebSocket, so the short-lived
  access JWT is passed as `?token=…` and verified with the same `verifyAccessToken` the REST
  middleware uses.
- **Protocol** (JSON text frames):

  ```
  client → { type:'subscribe',   deviceIds:[1,2] }   // [] or omit ⇒ all visible
  client → { type:'unsubscribe', deviceIds:[1] }
  client → { type:'ping' }
  server → { type:'welcome',    serverTime }
  server → { type:'subscribed', deviceIds:[…] }      // after visibility filter
  server → { type:'telemetry',  deviceId, fuel?, consumption?, alarms?, gps?, at }
  server → { type:'pong',       serverTime }
  ```

- **Visibility:** subscriptions run through `filterVisibleDevices` (`nav-scope.js`), so a
  client only receives telemetry for devices its user may see.
- **Push origin:** `index.js` calls `broadcastTelemetry(deviceId, payload)` whenever the fuel
  poll produces a fresh reading or alarm snapshot.

The frontend side is `hooks/useTelemetry.js` — see [frontend.md](frontend.md).

---

## Agent tunnel — historical

An earlier design added a third channel for devices on private site LANs: a small always-on
machine at each site ran an **agent** (formerly `agent/`) that dialed **out** to the server
over a WebSocket at `/agent-tunnel`, so the server could reach Modbus devices behind NAT with
no VPN or port-forwarding. The agent shared `shared/modbus-registers.js` with the server so
the two could never drift.

**This was removed in commit `9d3ea6d`** ("Remove agent tunnel; add single-instance guard;
harden Datakom reconnect"). The `agent/` folder now contains only leftover `node_modules` —
no agent code, and the server no longer exposes `/agent-tunnel`.

Stale references that have **not** been cleaned up yet (treat as out of date):

- `DEPLOY.md` — the architecture diagram and **step 8 "Connect the sites (agents)"** still
  describe the tunnel.
- `deploy/env.production.example` and `deploy/Caddyfile` — still mention `AGENT_TOKEN` /
  `/agent-tunnel`.
- `_start_tunnel_hidden.vbs` — leftover launcher.

Current reality: devices are reached via **direct Modbus TCP** (this document) or the
**Datakom cloud** ([datakom.md](datakom.md)). If site-behind-NAT reach is needed again, that
is new work, not a currently-shipping feature.
