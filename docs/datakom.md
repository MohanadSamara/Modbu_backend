# Datakom Rainbow cloud integration

Some devices are the **Datakom** brand. Rather than reading them over Modbus TCP, the backend
reads their live data from **Datakom's own Rainbow SCADA cloud** by speaking Datakom's
WebSocket protocol directly. This channel is **read-only**.

Three files:

- **`datakom-rainbow.js`** — the cloud WebSocket client (the read-only live data source).
- **`brand-adapters.js`** — the registry that maps a brand name to its adapter.
- **`datakom-sync.js`** — mirrors the cloud device tree into the platform's own DB rows.

---

## Why a custom client instead of a browser

Datakom's Rainbow SCADA portal (`cs.datakom.com.tr`, a Flutter app) talks to its backend over
a **single WebSocket**: `wss://rm.datakom.com.tr:464/`. Instead of driving a headless browser,
`datakom-rainbow.js` speaks that same protocol directly. The protocol was confirmed against
Datakom's official RPC application note, Datakom's own reference client
(`RainbowScadaClient.cs`), and a real captured session.

### Handshake / message flow

```
1. connect wss://rm.datakom.com.tr:464/            (auth is IN-BAND, over messages)
2. server → { Request:"usr_fedai", fedai:"…Rakam = …" }        (challenge)
3. client → { Request:"usr_login", UsrNam, UsrPwd, ComIdt:-1,
              AppMod:"V", MsgPrm:"NONE"|"JSON"|"DATA",
              Random:<.NET ticks>, RndNum:<answer to challenge> }
4. server → { Request:"usr_login", Access, SrvLic, ComLic }    (Access ≥ 1 = OK)
5. server → { Request:"node_list", NodeList:[{id,parent,name}] }
6. client → { Request:"devx_list", Node:<id>, Skip:0 }         (per node, paginated)
7. server → { Request:"devx_list", Node, Skip, Last, DevxList:[{did,sid,esn,lat,lng}] }
8. client → { Request:"devx_pump", job:1 }                     (after all nodes)
9. server → { Request:"devx_pump", job:2 }                     (pump primed → live data flows)
10. server → { Request:"dump_devm"|"dump_gway", did, …, MSG:{ VALUE:[{A,N,V,U}], EXTRA:{…} } }
```

The live `dump_devm` / `dump_gway` frames carry the readings (`VALUE` = array of
`{A(ddress), N(ame), V(alue), U(nit)}`), which the adapter maps into the same
fuel/telemetry shape the rest of the app expects.

### Hard constraints

- **Port 464 is IP-allowlisted by Datakom.** A non-whitelisted source IP gets the TLS
  handshake reset (`ECONNRESET`) before login. The adapter must run from a host whose public
  IP Datakom has whitelisted, or it will never connect. (This is a big reason the platform
  runs from one fixed server.)
- **The login is single-session.** Only one backend may hold the Datakom session at a time —
  which is why `single-instance.js` enforces one backend process
  ([ARCHITECTURE.md](ARCHITECTURE.md#runtime-topology)).
- **Read-only.** Remote control (start/stop) is *scaffolded* end-to-end in `sendControl()` /
  `buildControlFrame()` but **inert** — it will not send a guessed command frame to a real
  generator until the exact Rainbow command frame is captured. Control stays on the
  Modbus path ([modbus-and-device-io.md](modbus-and-device-io.md)).

### Configuration (`DK_*` env)

| Var | Meaning | Default |
|---|---|---|
| `DK_ENABLED` | `1`/`true` to activate | off |
| `DK_WS_URL` | endpoint | `wss://rm.datakom.com.tr:464/` |
| `DK_USER` / `DK_PASS` | portal credentials (never hard-coded) | — |
| `DK_PUSH` | `0`=no-push, `1`=JSON push (default), `2`=DATA push | `1` |
| `DK_INSECURE` | skip TLS validation (only if the cert is broken) | `0` |
| `DK_VERBOSE` | per-cycle connect/close/error logging | `0` |
| `DK_REPUMP_MS` | live-subscription refresh cadence (min 3000) | `8000` |

The enable state can also be **persisted in the DB** (`system_settings` key
`DK_ADAPTER_ENABLED` = `1`/`0`), which overrides `DK_ENABLED` at boot and is what the adapter
control API toggles.

---

## The brand-adapter seam (`brand-adapters.js`)

The platform is multi-brand: each device row carries a brand (`devices.brand_id` →
`brands.brand_name`). Most brands are read over Modbus; a few expose their own cloud source.
`brand-adapters.js` maps a brand **name** to its adapter:

```js
const ADAPTERS = { datakom };            // keyed by lower-cased brand name
const ALIASES  = { datacom: 'datakom' }; // "Datacom" is a common variant spelling
getAdapter(brand)  // → the adapter, or null when the brand is read over Modbus
startAll()         // start every configured adapter (each self-gates on its env config)
```

An adapter is any object exposing this **read-only** surface:

| Method | Purpose |
|---|---|
| `start()` | Begin/maintain the connection (idempotent). |
| `isReady()` | True once live data is flowing. |
| `getStatus()` | Connection + session diagnostics. |
| `listDevices()` | Devices the brand exposes, each with its latest reading. |
| `getReading(idOrName)` | One device's latest reading. |

Adding another cloud brand later is just: write an adapter with this surface, and add it to
`ADAPTERS`. The brand-scoped endpoints in `index.js`
(`/api/brands/:brand/devices`, `/api/brands/:brand/device/:id`, `/api/brands/:brand/tree`,
`/api/brands/:brand/status`) all resolve through `getAdapter`.

---

## Cloud → DB sync (`datakom-sync.js`)

The adapter gives live *readings*; the sync turns Datakom's cloud **tree** into real platform
rows (projects / locations / devices) so cloud devices appear in the normal hierarchy, can be
named, grouped, permission-scoped, and linked.

Entry points: `runSync()` (one pass), `startSyncLoop()` (periodic), `getSyncStatus()`,
`configure({ refreshDidMap })`. Exposed via the API:

| Endpoint | Action |
|---|---|
| `POST /api/brands/datakom/adapter/{start,stop,restart}` | Control the cloud connection at runtime. |
| `POST /api/brands/datakom/sync` | Run a sync now. |
| `GET /api/brands/datakom/sync/status` | Last sync result. |
| `GET/PUT /api/brands/datakom/node-names/:nodeId` | Custom display name for a cloud node. |
| `GET/PUT /api/brands/datakom/node-containers/:nodeId` | Group a cloud node under a local container. |

### Idempotency & safety

The sync must be safe to run repeatedly without duplicating rows or fighting the user's edits:

- **Match by map row, never by name.** `datakom_node_map` records which project/location row
  was created for each cloud node (`node:<id>` / `folder:<name>` / `ungrouped`). User renames
  and moves therefore **survive** later syncs.
- **Tombstone on delete.** `datakom_did_map` has one row per Datakom device id ever imported.
  If the user deletes the created `devices` row, the map row remains and the sync **never
  recreates** the device.
- **Name-fallback insert** (`insertWithNameFallback`) resolves unique-name collisions when
  creating projects/locations/devices.
- Helpers: `createProject`, `createLocation`, `createDevice` (assigns the next device id,
  sets `brand_id` and `datakom_did`).

See the table schemas in [database.md](database.md#datakom-cloud-sync-tables).

---

## How it surfaces in the UI

- **Datakom Connection** page (`/datakom`) — adapter status + start/stop/restart/sync
  controls (status needs `datakom.read`/`device.read`; the buttons need `datakom.write`).
- **Brands** page (`/brands`) — brand list + per-brand live device view.
- Live cloud readings also flow into the standard Dashboard / Fuel / Map views once devices
  are synced and linked.

Frontend clients: `api/datakom.js`, `api/brands.js`, components `DatakomLivePanel.jsx` /
`DatakomDeviceLive.jsx`. See [frontend.md](frontend.md).
