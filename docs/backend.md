# Backend

The backend is a single Node.js + Express 5 application. `index.js` is the entry point; it
wires global middleware, mounts two routers, defines the bulk of the API routes inline, boots
the database and adapters, attaches the telemetry WebSocket, and calls `app.listen`.

## File map

| File | Responsibility |
|---|---|
| **`index.js`** (~2900 lines) | Express app. Global middleware (`index.js:58–68`), router mounts (`index.js:231–232`), all inline device/project/brand/settings routes, startup (DB ensure functions, `brand-adapters.startAll`, `datakom-sync.startSyncLoop`), single-instance lock, `app.listen(PORT)` + telemetry WS attach. |
| **`db.js`** (~1900 lines) | Oracle connection pool (`getConnection`), every query helper, and `ensure*` functions that idempotently create the auxiliary tables + seed RBAC at startup. See [database.md](database.md). |
| **`auth.js`** | Auth core: `hashPassword`/`verifyPassword` (bcrypt), `signAccessToken`/`verifyAccessToken` (JWT), refresh-session issue/consume/revoke, lockout (`isAccountLocked`, `recordFailedLogin`), `logAudit`, and permission resolution (`userHasPermission`, `userHasAnyPermission`, `getUserRolesAndPermissions`, `_resolveScopeChain`). See [auth-rbac.md](auth-rbac.md). |
| **`middleware.js`** | Express guards: `authenticate`, `optionalAuthenticate`, `requirePermission`, `requireAnyPermission`, `requirePermissionIfBodyPresent`, and the dynamic `enforceMappedPermissions`. |
| **`routes-auth.js`** | The `/api/auth` router (6 routes). |
| **`routes-users.js`** | The user/role/permission/audit router mounted at `/api` (~37 routes). |
| **`rbac-defaults.js`** | Single source of truth for built-in permission keys, system roles, permission implications, and the UI-element catalog. |
| **`nav-scope.js`** | `filterVisibleDevices` and scope helpers — restricts result sets to what the requesting user may see. |
| **`modbus_connect.js`** | Modbus TCP engine + read/control operations. See [modbus-and-device-io.md](modbus-and-device-io.md). |
| **`shared/modbus-registers.js`** | Pure register map + decode/encode helpers for Datakom D-300/500/700. |
| **`lib/telemetry-math.js`** | `computeConsumption`, `bucketEvents`, `describeAlarm`. |
| **`telemetry-ws.js`** | `/ws/telemetry` browser push server + `broadcastTelemetry`. |
| **`datakom-rainbow.js`** | Datakom Rainbow cloud client. See [datakom.md](datakom.md). |
| **`datakom-sync.js`** | Cloud tree → DB sync. |
| **`brand-adapters.js`** | Brand → adapter registry (`getAdapter`, `startAll`). |
| **`single-instance.js`** | Port-keyed cross-process lock (`acquire`/`release`). |

## How the app is assembled (`index.js`)

```
PORT = --port arg | process.env.PORT | 3000        (5400 in the real deployment)
app.use(cors({ origin: CORS_ORIGINS.split(',') }))
app.use(express.json()); app.use(express.urlencoded())
app.use(express.static('public'))
app.use(optionalAuthenticate, enforceMappedPermissions)   // global, non-blocking auth + dynamic map
app.use('/api/auth', authRoutes)                          // routes-auth.js
app.use('/api',      userRoutes)                          // routes-users.js
…all inline app.get/post/put/delete('/api/...') routes…
(if built frontend present) app.use(express.static(FRONTEND_DIR)) + SPA fallback
server = app.listen(PORT)
telemetryWs.attach(server)                                // /ws/telemetry
```

Default allowed CORS origins are `http://localhost:5173,http://localhost:3000` unless
`CORS_ORIGINS` overrides them (`index.js:56`).

---

## HTTP endpoint reference

Every route below is guarded exactly as written in the source. `authenticate` = a valid
access token is required; the permission names are the RBAC keys from
[auth-rbac.md](auth-rbac.md). `requireAny` means holding **any one** of the listed permissions
is sufficient.

### Auth — `routes-auth.js` (mounted at `/api/auth`)

| Method | Path | Guard | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | none | Authenticate; returns access + refresh tokens. |
| POST | `/api/auth/refresh` | none (refresh token in body) | Rotate the refresh token, mint a new access token. |
| POST | `/api/auth/logout` | none (refresh token in body) | Revoke the current session. |
| POST | `/api/auth/logout-all` | authenticate | Revoke all of the user's sessions. |
| GET | `/api/auth/me` | authenticate | Current user + roles + effective permissions. |
| POST | `/api/auth/change-password` | authenticate | Change own password. |

### Health & session — `index.js`

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET | `/api/health` | none | Liveness (`{ ok, uptime }`). |
| GET | `/api/modbus/session` | `device.read` | Current Modbus connection/session state. |

### Modbus control & reads — `index.js`

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET | `/api/modbus/connect?device_id=<id>` | `device.connect` | Open a Modbus connection to a specific device. |
| GET | `/api/modbus/disconnect` | `device.connect` | Close the current connection. |
| GET | `/api/modbus/start` | any `device.start` \| `device.control` | Start the generator (logs a `START` action). |
| GET | `/api/modbus/stop` | any `device.stop` \| `device.control` | Stop the generator (logs a `STOP` action). |
| GET | `/api/modbus/fuel` | `fuel.read` | Read fuel %; persists a reading, may raise an alarm, broadcasts telemetry. |
| GET | `/api/modbus/gps` | `device.read` | Read GPS position. |
| GET | `/api/modbus/telemetry` | `device.read` | Full telemetry snapshot (engine block + RPM + battery + GPS). |
| GET | `/api/modbus/registers/read` | `device.read` | Read an arbitrary holding-register block. |
| GET | `/api/registers` | `device.read` | Register table for the UI. |

### Fuel history, stats, alarms — `index.js`

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET | `/api/fuel-history/:deviceId` | `fuel.read` | Historical fuel readings. |
| GET | `/api/consumption-rate/:deviceId` | `fuel.read` | Computed consumption rate. |
| GET | `/api/stats` | `device.read` | Aggregate stats for charts. |
| GET | `/api/events` | `alarm.read` | Recent events (action log). |
| GET | `/api/device-actions` | `alarm.read` | Recent device actions. |
| GET | `/api/alarms` | `alarm.read` | Stored alarms. |
| POST | `/api/alarms/:id/acknowledge` | `alarm.read` | Acknowledge an alarm. |
| GET | `/api/alarms/live` | `alarm.read` | Live alarm snapshot across visible devices. |
| GET | `/api/alarms/live/:deviceId` | `alarm.read` | Live alarms for one device. |
| GET | `/api/devices/:deviceId/snooze` | `alarm.read` | Get the device's alarm snooze. |
| PUT | `/api/devices/:deviceId/snooze` | `alarm.read` | Set/clear the device's alarm snooze. |

### Projects & locations (hierarchy) — `index.js`

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET | `/api/projects` | authenticate | List projects (scope-filtered). |
| POST | `/api/projects` | `project.write` | Create a project (optional `brand_id`, `method`). |
| GET | `/api/projects/:id` | `project.read` | Single project. |
| PUT | `/api/projects/:id` | `project.write` | Update a project. |
| DELETE | `/api/projects/:id` | `project.write` | Delete a project. |
| GET | `/api/projects/:projectId/locations` | authenticate | Hierarchical location tree (recursive JSON). |
| POST | `/api/projects/:projectId/locations` | any `project.write` \| `location.write` | Create a location (optional `parent_id`). |
| GET | `/api/locations/:id` | any `project.read` \| `location.read` | Single location. |
| PUT | `/api/locations/:id` | any `project.write` \| `location.write` | Update a location (incl. `parent_id` move). |
| DELETE | `/api/locations/:id` | any `project.write` \| `location.write` | Delete a location. |
| GET | `/api/locations/:id/children` | any `project.read` \| `location.read` | Direct sub-locations. |
| GET | `/api/locations/:locationId/devices` | `device.read` | Devices in a location. |
| GET | `/api/project-tree` | `project.read` | Flat tree view of the whole hierarchy. |

### Devices — `index.js`

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET | `/api/devices` | authenticate | List devices (scope-filtered). |
| POST | `/api/devices` | `device.write` (+ `datakom.write` if `datakom_did` in body) | Create a device. |
| PUT | `/api/devices/:deviceId` | `device.write` (+ `datakom.write` if `datakom_did` in body) | Update a device. |
| DELETE | `/api/devices/:deviceId` | `device.write` | Delete a device. |

`requirePermissionIfBodyPresent('datakom_did', 'datakom.write')` means linking/unlinking a
device to a Datakom cloud id additionally requires `datakom.write`.

### Brands & Datakom adapter control — `index.js`

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET | `/api/brands` | `device.read` | List brands. |
| POST | `/api/brands` | `device.write` | Create a brand. |
| PUT | `/api/brands/:id` | `device.write` | Update a brand. |
| DELETE | `/api/brands/:id` | `device.write` | Delete a brand. |
| GET | `/api/brands/:brand/status` | any `device.read` \| `datakom.read` | Brand adapter connection status. |
| POST | `/api/brands/datakom/adapter/start` | `datakom.write` | Start the Datakom cloud adapter. |
| POST | `/api/brands/datakom/adapter/stop` | `datakom.write` | Stop the adapter. |
| POST | `/api/brands/datakom/adapter/restart` | `datakom.write` | Restart the adapter. |
| POST | `/api/brands/datakom/sync` | `datakom.write` | Run a cloud→DB sync now. |
| GET | `/api/brands/datakom/sync/status` | any `datakom.read` \| `device.read` | Last sync status. |
| GET | `/api/brands/:brand/devices` | any `device.read` \| `datakom.read` | Devices the brand exposes (with latest reading). |
| GET | `/api/brands/:brand/device/:id` | any `device.read` \| `datakom.read` \| `fuel.read` | One brand device's latest reading. |
| GET | `/api/brands/:brand/tree` | any `device.read` \| `datakom.read` | Brand's node/device tree. |
| GET | `/api/brands/datakom/node-names` | any `device.read` \| `datakom.read` \| `fuel.read` | Custom node-name overrides. |
| PUT | `/api/brands/datakom/node-names/:nodeId` | `datakom.write` | Set a node's custom name. |
| GET | `/api/brands/datakom/node-containers` | any `device.read` \| `datakom.read` \| `fuel.read` | Node → local container grouping. |
| PUT | `/api/brands/datakom/node-containers/:nodeId` | `datakom.write` | Set a node's container. |
| POST | `/api/brands/:brand/device/:id/start` | (device control guard) | Start a brand device (Modbus path; inert for read-only adapters). |
| POST | `/api/brands/:brand/device/:id/stop` | (device control guard) | Stop a brand device. |

### Settings & page content — `index.js`

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET | `/api/device-settings/:deviceId` | `settings.read` | Per-device settings. |
| PUT | `/api/device-settings/:deviceId` | `settings.write` | Update per-device settings. |
| GET | `/api/settings` | `settings.read` | System settings. |
| PUT | `/api/settings` | `settings.write` | Update system settings. |
| GET | `/api/page-content` | authenticate | Editable page-content overrides (for the in-app page editor). |
| PUT | `/api/page-content` | `settings.write` | Save page-content overrides. |

### Users, roles, permissions, audit — `routes-users.js` (mounted at `/api`)

**Users**

| Method | Path | Guard |
|---|---|---|
| GET | `/api/users` | `user.read` |
| GET | `/api/users/:id` | `user.read` |
| POST | `/api/users` | `user.write` |
| PUT | `/api/users/:id` | `user.write` |
| DELETE | `/api/users/:id` | `user.write` |
| POST | `/api/users/:id/reset-password` | `user.write` |
| POST | `/api/users/:id/lock` | `user.write` |
| POST | `/api/users/:id/unlock` | `user.write` |
| POST | `/api/users/:id/roles` | `user.assign_role` |
| DELETE | `/api/users/:id/roles/:userRoleId` | `user.assign_role` |

**Roles**

| Method | Path | Guard |
|---|---|---|
| GET | `/api/roles` | `user.read` |
| POST | `/api/roles` | `user.assign_role` |
| PUT | `/api/roles/:id` | `user.assign_role` |
| DELETE | `/api/roles/:id` | `user.assign_role` |
| POST | `/api/roles/reset` | `user.assign_role` |
| GET | `/api/roles/:id/permissions` | `user.read` |
| POST | `/api/roles/:id/permissions` | `user.assign_role` |
| DELETE | `/api/roles/:id/permissions/:pid` | `user.assign_role` |

**Permissions & endpoint/element mappings**

| Method | Path | Guard |
|---|---|---|
| GET | `/api/permissions` | `user.read` |
| POST | `/api/permissions` | `user.assign_role` |
| PUT | `/api/permissions/:id` | `user.assign_role` |
| DELETE | `/api/permissions/:id` | `user.assign_role` |
| POST | `/api/permissions/reset` | `user.assign_role` |
| GET | `/api/permissions/:id/endpoints` | `user.read` |
| POST | `/api/permissions/:id/endpoints` | `user.assign_role` |
| DELETE | `/api/permission-endpoints/:endpointId` | `user.assign_role` |
| GET | `/api/permissions/:id/elements` | `user.read` |
| POST | `/api/permissions/:id/elements` | `user.assign_role` |
| DELETE | `/api/permissions/:id/elements/:elementId` | `user.assign_role` |

**UI-element catalog & UI features**

| Method | Path | Guard |
|---|---|---|
| GET | `/api/ui-elements` | authenticate |
| GET | `/api/ui-element-catalog` | authenticate |
| POST | `/api/ui-element-catalog` | `user.assign_role` |
| DELETE | `/api/ui-element-catalog/:id` | `user.assign_role` |
| GET | `/api/ui-features` | authenticate |
| PUT | `/api/ui-features/:featureId` | `user.assign_role` |
| DELETE | `/api/ui-features/:featureId` | `user.assign_role` |

**Audit**

| Method | Path | Guard |
|---|---|---|
| GET | `/api/audit` | `audit.read` |

---

## Environment / configuration reference

Set via `.env` (local) or the container environment (production — see
`deploy/env.production.example`).

| Var | Used for | Default / example |
|---|---|---|
| `PORT` | HTTP listen port | `3000` (dev) / `5400` (deployed) |
| `CORS_ORIGINS` | Comma-separated allowed browser origins | `http://localhost:5173,http://localhost:3000` |
| `JWT_SECRET` | Signs access tokens — **must** be long & random in prod | — |
| `ORACLE_USER` | Schema/app user | `MODBUS_ADMIN` |
| `ORACLE_PASSWORD` | App user password | — |
| `ORACLE_HOST` / `ORACLE_PORT` | DB host/port | `localhost` / `1521` |
| `ORACLE_SERVICE_NAME` | Oracle service | `XE` / `XEPDB1` |
| `MODBUS_PORT` | Default Modbus TCP port | `502` |
| `MODBUS_UNIT_ID` | Default Modbus unit id | `1` |
| `MODBUS_IP` | Fallback device IP | per device |
| `DK_ENABLED` | Enable the Datakom cloud adapter | `0` (off) |
| `DK_WS_URL` | Datakom endpoint | `wss://rm.datakom.com.tr:464/` |
| `DK_USER` / `DK_PASS` | Datakom portal credentials | — |
| `DK_PUSH` | Push mode: `0`=none, `1`=JSON, `2`=DATA | `1` |
| `DK_INSECURE` | Skip TLS cert validation | `0` |
| `DK_VERBOSE` | Per-cycle connect/close logging | `0` |
| `DK_REPUMP_MS` | Live-subscription refresh cadence (min 3000) | `8000` |

> `AGENT_TOKEN` still appears in `deploy/env.production.example` but the agent tunnel it
> secured was removed in `9d3ea6d` — it is currently unused. See
> [modbus-and-device-io.md](modbus-and-device-io.md#agent-tunnel--historical).

The Datakom runtime enable state can also be persisted in the DB (`system_settings` key
`DK_ADAPTER_ENABLED` = `1`/`0`), which overrides `DK_ENABLED` at boot and via the adapter
control API. See [datakom.md](datakom.md).
