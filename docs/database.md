# Database

The backend uses **Oracle** (Oracle XE in production). All application objects live in the
**`MODBUS_ADMIN`** schema. Connections come from a pool managed in `db.js` (`getConnection`).

## Two classes of tables

1. **Core tables** — `users`, `devices`, `projects`, `locations`, `brands`, `device_actions`,
   `device_readings`, `roles`, `permissions`, `role_permissions`, `permission_endpoints`,
   `audit_log`, `user_sessions`, `user_roles`, and their sequences. **The app does NOT create
   these** — there is no shipped `schema.sql` for them. They are provisioned by importing an
   existing dump with Oracle Data Pump (see [deploy.md](deploy.md), step 6). The columns below
   for core tables are documented from how `db.js`/`index.js` query them.

2. **Auxiliary tables** — created idempotently at startup by `ensure*` functions in `db.js`
   (each wraps `CREATE TABLE` and swallows `ORA-00955 "name already used"`). These are
   defined fully in code, transcribed exactly below.

## Entity model

```
projects (id, name, description, brand_id→brands, method 'cloud'|'ip', parent_id→projects)
   │  1
   │  ▼ *
locations (id, name, description, address, project_id→projects, parent_id→locations)   ← self-nesting tree
   │  1
   │  ▼ *
devices (device_id, device_name, device_ip, device_port, location_id→locations,
         brand_id→brands, datakom_did, status, last_seen)
   │  1
   ├─▼ * device_actions   (START/STOP/… audit of control ops)
   ├─▼ * device_readings  (FUEL % samples over time)
   ├─▼ * device_settings  (per-device key/value)
   ├─▼ * device_snoozes   (alarm snooze, 1:1)
   └─▼ * alarms           (triggered alarms)
```

- **Projects can nest** (`parent_id` self-reference — a project can live inside a container
  project).
- **Locations form a tree** within a project (`parent_id` self-reference); the API returns
  them as recursive JSON (`GET /api/projects/:projectId/locations`).
- **A project carries a brand + method.** `method` is `'cloud'` (Datakom Rainbow) or `'ip'`
  (Modbus TCP) and sets the default connection type of devices created under it. Added by
  `migrations/2026-07-add-project-brand-method.sql`.

## Core tables (from Data Pump import)

### `devices`
Columns referenced in queries: `device_id` (PK), `device_name`, `device_ip`, `device_port`,
`location_id` (FK → `locations`), `brand_id` (FK → `brands`), `datakom_did` (Datakom cloud
device id when linked), `status`, `last_seen`. Modbus connect/read/control all resolve their
target from this row (`getDeviceConfig` in `modbus_connect.js`).

### `projects` / `locations`
`id` (PK), `name`, `description`, `address` (locations), `project_id`, `parent_id`,
`created_at`, `updated_at`, plus `brand_id` + `method` on `projects`.

### `device_actions`
`action_id` (PK, from `device_action_seq`), `device_id`, `action_type` (e.g. `START`,
`STOP`), `action_time`. Written on every control operation.

### `device_readings`
`reading_id` (PK, from `device_reading_seq`), `device_id`, `reading_type` (e.g. `FUEL`),
`reading_value`, `reading_unit` (e.g. `%`), `reading_time`. This is the fuel-history source.

### RBAC core tables
`users`, `roles`, `permissions`, `role_permissions`, `user_roles`, `user_sessions`,
`audit_log`, `permission_endpoints`. Documented in [auth-rbac.md](auth-rbac.md).

## Auxiliary tables (auto-created by `db.js`)

### `alarms` — `ensureAlarmsTable` (`db.js:391`)
```
alarm_id        NUMBER PRIMARY KEY
device_id       NUMBER NOT NULL            → devices(device_id) ON DELETE CASCADE
alarm_type      VARCHAR2(50) NOT NULL
severity        VARCHAR2(16) NOT NULL
message         VARCHAR2(400)
fuel_value      NUMBER
threshold_value NUMBER
triggered_at    TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
acknowledged    NUMBER(1) DEFAULT 0 NOT NULL
acknowledged_by NUMBER
acknowledged_at TIMESTAMP
-- INDEX ix_alarms_active (acknowledged, triggered_at)  ← Active Alarms query
```

### `device_snoozes` — `ensureSnoozeTable` (`db.js:742`)
```
device_id    NUMBER PRIMARY KEY          → devices(device_id) ON DELETE CASCADE
snooze_until NUMBER NOT NULL             -- epoch ms until which alarms are muted
updated_by   NUMBER
updated_at   TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
```

### `system_settings` — `ensureSettingsTables` (`db.js:1245`)
```
setting_key   VARCHAR2(64) PRIMARY KEY
setting_value VARCHAR2(4000)
setting_type  VARCHAR2(16) DEFAULT 'string' NOT NULL
updated_at    TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
```
Notable key: `DK_ADAPTER_ENABLED` (`'1'`/`'0'`) — persisted Datakom adapter enable override.

### `device_settings` — `ensureSettingsTables` (`db.js:1257`)
```
device_id     NUMBER NOT NULL
setting_key   VARCHAR2(64) NOT NULL
setting_value VARCHAR2(4000)
setting_type  VARCHAR2(16) DEFAULT 'string' NOT NULL
updated_at    TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
PRIMARY KEY (device_id, setting_key)
```

### `page_content` — `ensurePageContentTable` (`db.js:1162`)
```
content_key  VARCHAR2(64) PRIMARY KEY   -- e.g. 'GLOBAL'
content_json CLOB NOT NULL              -- JSON blob of UI text overrides
updated_by   NUMBER
updated_at   TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
```
Backs the in-app page editor (`PUT /api/page-content`).

### `ui_element_catalog` — `ensureUiElementCatalog` (`db.js:1389`)
```
element_id VARCHAR2(60) PRIMARY KEY
field      VARCHAR2(40)               -- resource area used to group in the editor
label      VARCHAR2(200)
sort_order NUMBER DEFAULT 999
```
Seeded (MERGE, insert-if-missing) from `rbac-defaults.js` `UI_ELEMENT_CATALOG`.

### `permission_ui_elements`
Maps a permission key to a UI element id. Populated by defaults and edited from the
Permissions page. Reset by `ensureRbacSeed`/reset routes (`db.js:1456–1459`).

## Datakom cloud-sync tables

Documented in `migrations/2026-07-datakom-sync.sql` and auto-created by `ensureDatakomSyncTables`
(`db.js:1065`).

### `datakom_node_map` (`db.js:1071`)
Idempotency anchor: which project/location row the sync created for each cloud node. Matched
by map row, never by name — so user renames/moves survive later syncs.
```
node_key    VARCHAR2(64) NOT NULL   -- 'node:<cloud node id>' | 'folder:<name>' | 'ungrouped'
entity_type VARCHAR2(10) NOT NULL CHECK (entity_type IN ('project','location'))
entity_id   NUMBER NOT NULL         -- projects.id or locations.id
created_at  TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
PRIMARY KEY (node_key, entity_type)
```

### `datakom_did_map` (`db.js:1084`)
Idempotency anchor + tombstone for cloud devices: one row per Datakom device id ever imported.
If the user deletes the `devices` row, this row remains and the sync never recreates it.
```
did        NUMBER PRIMARY KEY   -- Datakom device id (devices.datakom_did)
device_id  NUMBER               -- the devices row the sync created (informational)
created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
```

### `datakom_node_names` — `ensureDatakomNodeNamesTable` (`db.js:899`)
User-facing custom name override for a cloud node.
```
node_id     VARCHAR2(128) PRIMARY KEY
custom_name VARCHAR2(200) NOT NULL
updated_by  NUMBER
updated_at  TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
```

### `datakom_node_containers` — `ensureDatakomNodeContainersTable` (`db.js:983`)
Assigns a cloud node to a local grouping container.
```
node_id        VARCHAR2(128) PRIMARY KEY
container_name VARCHAR2(200) NOT NULL
updated_by     NUMBER
updated_at     TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
```

## Migrations folder

| File | What it does |
|---|---|
| `migrations/2026-07-add-project-brand-method.sql` | Adds `brand_id` (FK → `brands`, `ON DELETE SET NULL`) and `method` (`CHECK IN ('cloud','ip')`, default `'ip'`) to `projects`; backfills existing rows to `'ip'`. Re-running the `ADD`s errors with ORA-01430 (column exists) — safe to ignore. |
| `migrations/2026-07-datakom-sync.sql` | Reference DDL for `datakom_node_map` + `datakom_did_map` (these auto-create in `db.js`; the file documents them and the `DK_ADAPTER_ENABLED` setting). |

## Startup sequence (schema side)

At boot, `index.js` calls the `db.js` `ensure*` functions, which:
1. Create any missing auxiliary tables (idempotent).
2. `ensureProjectParentColumn` — adds the self-nesting `parent_id` to legacy `projects`.
3. `ensureRbacSeed` — inserts any missing built-in permission and system role (non-destructive:
   an admin's later edits to a system role are never clobbered).
4. `ensureUiElementCatalog` — MERGE-seeds the UI element catalog from `rbac-defaults.js`.

Sequences used: `alarm_seq`, `device_action_seq`, `device_reading_seq` (with an in-code
`MAX(id)+1` fallback path when a sequence isn't present).
