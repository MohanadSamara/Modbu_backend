# Architecture

## What this system is, in one sentence

Modbus Hub is a permission-controlled web platform that monitors and controls a fleet of
Modbus generators — reaching each device either directly over **Modbus TCP** or through
**Datakom's Rainbow SCADA cloud** — organizes them into a Projects → Locations → Devices
hierarchy in Oracle, and pushes **live fuel/telemetry/alarm updates** to a React dashboard
over a WebSocket.

## Topology

```
                              ┌─────────────────────────────────────────────┐
   Browser (React SPA)        │                 ONE SERVER                   │
        │                     │                                             │
        │  HTTPS  /            │   ┌────────┐   static files   ┌──────────┐  │
        ├─────────────────────┼──▶│  Caddy │─────────────────▶│  React   │  │
        │                     │   │ (TLS,  │                  │  build   │  │
        │  WSS  /ws/telemetry │   │ proxy) │   /api  /ws       └──────────┘  │
        └─────────────────────┼──▶│        │──────────────┐                  │
                              │   └────────┘              ▼                  │
                              │                    ┌─────────────┐           │
                              │                    │   Node.js   │           │
                              │                    │  backend    │──────────┐│
                              │                    │ (Express 5) │  Oracle  ││
                              │                    └──────┬──────┘  SQL      ▼│
                              │                           │        ┌──────────┐
                              │            ┌──────────────┼───────▶│ Oracle XE│
                              │            │              │        │MODBUS_   │
                              │            │              │        │  ADMIN   │
                              └────────────┼──────────────┼────────└──────────┘
                                           │              │
                       Modbus TCP (fn 3/6) │              │ WSS (in-band login)
                                           ▼              ▼
                                   ┌──────────────┐  ┌────────────────────────┐
                                   │  Generator   │  │  Datakom Rainbow cloud  │
                                   │  (D-300/500/ │  │  rm.datakom.com.tr:464  │
                                   │   700 unit)  │  │  (read-only live data)  │
                                   └──────────────┘  └────────────────────────┘
```

Two independent device channels:

1. **Direct Modbus TCP** — the backend opens a Modbus socket straight to the device's IP and
   reads/writes holding registers (`modbus_connect.js` + `shared/modbus-registers.js`). This
   is the control channel: start/stop actually work here.
2. **Datakom Rainbow cloud** — for `Datakom`-brand devices, the backend logs into Datakom's
   own cloud WebSocket and streams live readings (`datakom-rainbow.js`). **Read-only** — see
   [datakom.md](datakom.md).

> **Historical note:** a third channel — a site-agent reverse tunnel (`/agent-tunnel`) that
> let devices on private LANs be reached without port-forwarding — existed but was **removed
> in commit `9d3ea6d`**. See [modbus-and-device-io.md](modbus-and-device-io.md#agent-tunnel--historical).

## Repo layout (backend)

| Path | Role |
|---|---|
| `index.js` | Express app: wires middleware, mounts routers, defines all inline `/api/*` routes, boots DB + adapters + telemetry WS, `app.listen`. |
| `db.js` | Oracle connection pool + every SQL helper; auto-creates auxiliary tables at startup. |
| `auth.js` | Password hashing, JWT access + refresh-session tokens, lockout, audit log, permission resolution. |
| `middleware.js` | `authenticate`, `requirePermission`, `requireAnyPermission`, `enforceMappedPermissions`. |
| `routes-auth.js` | `/api/auth/*` — login, refresh, logout, me, change-password. |
| `routes-users.js` | `/api/*` — users, roles, permissions, UI-element catalog, audit (~37 routes). |
| `rbac-defaults.js` | Canonical permission keys, system roles, implications, UI-element catalog. |
| `nav-scope.js` | Filters which devices/projects a user may see. |
| `modbus_connect.js` | Modbus TCP connection engine (hubs, locking, reconnect) + read/control ops. |
| `shared/modbus-registers.js` | Datakom D-series register map + decode/encode helpers (pure module). |
| `lib/telemetry-math.js` | Consumption-rate math, event bucketing, alarm descriptions. |
| `telemetry-ws.js` | Browser-facing `/ws/telemetry` live push server. |
| `datakom-rainbow.js` | Datakom Rainbow cloud WebSocket client (read-only live data adapter). |
| `datakom-sync.js` | Mirrors the Datakom cloud tree into DB projects/locations/devices. |
| `brand-adapters.js` | Brand-name → cloud-adapter registry (the extensibility seam). |
| `single-instance.js` | Cross-process lock ensuring only ONE backend runs at a time. |
| `migrations/` | Reference SQL for schema changes (some tables auto-create in `db.js`). |
| `deploy/` | Caddyfile, production env example, built frontend (`www/`), DB dumps. |
| `public/` | Static assets served by the backend. |

Frontend repo: `Desktop/FrontEndModbus/Modbus-front` — see [frontend.md](frontend.md).

## Runtime topology

- **Single process, port 5400.** In production/Windows the backend runs as a hidden
  scheduled task (`_start_backend_hidden.vbs`) on port **5400**. `PORT` can be set by
  `--port <n>` CLI arg, the `PORT` env var, or defaults to `3000` (`index.js:49–54`).
- **One-instance rule.** `single-instance.js` acquires a lock keyed on the port at boot
  (`index.js:2775`). A second backend refuses to start. This exists because the **Datakom
  Rainbow cloud login is single-session** — two backends would fight over the same portal
  session. See [datakom.md](datakom.md).
- **Backend also serves the frontend.** When a built frontend is present, the backend serves
  it statically and falls back to `index.html` for non-`/api`/`/ws` paths (`index.js:2758–2764`).
- **Public exposure** is via Caddy (production) or an ngrok / Cloudflare tunnel (dev) — see
  [deploy.md](deploy.md).

## End-to-end request lifecycle

Every authenticated `/api/*` call flows through the same pipeline:

```
HTTP request
  │
  ├─ cors(allowedOrigins)                         index.js:58
  ├─ express.json / urlencoded                    index.js:59–60
  ├─ optionalAuthenticate → enforceMappedPermissions   index.js:68
  │     (attaches req.user if a token is present; blocks requests whose
  │      target endpoint has an admin-defined UI-element permission mapping)
  │
  ├─ route-level guard:  authenticate             (401 if no/blocked token)
  │                      requirePermission('x')   (403 if the user lacks x)
  │                      requireAnyPermission([…]) (403 unless the user holds one)
  │
  ├─ handler runs → db.js query(s)
  │     └─ nav-scope.filterVisibleDevices(...)     (drops rows out of the user's scope)
  │
  └─ JSON response
```

- **`optionalAuthenticate`** never rejects — it just attaches `req.user` if a valid token is
  present, so the mapping layer and public-ish routes can run.
- **`enforceMappedPermissions`** is the *dynamic* layer: admins can map a UI element →
  endpoint pattern → permission in the database, and this middleware enforces those without a
  code change. See [auth-rbac.md](auth-rbac.md).
- **`requirePermission` / `requireAnyPermission`** are the *static* guards hard-coded on each
  route (the guard names appear in [backend.md](backend.md)'s endpoint tables).

## Tech stack

**Backend** (`package.json`): Node.js, Express `^5.2`, `oracledb` `^6.10`, `modbus-serial`
`^8.0`, `ws` `^8.21`, `jsonwebtoken` `^9`, `bcrypt` `^6`, `cors`, `dotenv`, `axios`.

**Frontend** (`package.json`): React `^19.2`, `react-dom`, `react-router-dom` `^6.30`,
`recharts` `^2.15` (charts), `leaflet` + `react-leaflet` `^5` (device map),
`framer-motion` `^12` (animation); built with Vite `^8`, styled with Tailwind CSS `^3.4`.
