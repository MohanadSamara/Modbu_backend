# Authentication & Authorization (RBAC)

Two concerns, kept separate:

- **Authentication** — *who are you?* Handled by `auth.js` (server) + `api/http.js` (client)
  with JWT access tokens and DB-backed refresh sessions.
- **Authorization** — *what may you do?* A fine-grained, scoped **role-based access control**
  system. Canonical data lives in `rbac-defaults.js`; enforcement lives in `middleware.js` +
  `auth.js`.

---

## Authentication

### Token model

| Token | Lifetime | Storage (client) | Purpose |
|---|---|---|---|
| **Access token** (JWT) | **15 min** (`ACCESS_TOKEN_TTL_SEC`) | in-memory only (`api/http.js`) | Sent as `Authorization: Bearer …` on every API call. Payload: `{ sub: user_id, username }`. Signed with `JWT_SECRET`. |
| **Refresh token** (opaque) | **7 days** (`REFRESH_TOKEN_TTL_MS`) | `sessionStorage` (clears on tab close) | Exchanged at `/api/auth/refresh` for a fresh access token. 96 hex chars, random. |

- Passwords are hashed with **bcrypt** (`hashPassword`/`verifyPassword`).
- The refresh token is **never stored raw** — only its SHA-256 hash goes into
  `user_sessions` (`_hashRefreshToken`, `issueSession` at `auth.js:77`). The raw value is
  returned to the client once.
- **Rotation:** `consumeRefreshToken` validates + rotates on each refresh, so a stolen old
  refresh token stops working after the next legitimate refresh.
- **Revocation:** `revokeSessionByToken` (logout) and `revokeAllSessions` (logout-all).
- `JWT_SECRET` must be ≥32 chars; a dev-only fallback is used with a loud warning otherwise
  (`auth.js:29–36`). **Set a strong secret in production.**

### Account lockout

`MAX_FAILED_LOGINS = 5`, `LOCK_DURATION_MIN = 15`. `recordFailedLogin` increments a counter;
`isAccountLocked` blocks login for 15 minutes after 5 failures; `recordSuccessfulLogin`
resets it.

### Audit log

`logAudit({ userId, usernameTry, eventType, ip, userAgent, detail })` records login attempts
and sensitive actions to `audit_log`, surfaced via `GET /api/audit` (needs `audit.read`).

### Client-side flow (`api/http.js`)

Every request injects the in-memory access token. On a **401**, the wrapper transparently
calls `/api/auth/refresh` **once** and retries; if refresh fails it invokes an
`onAuthFailed` callback (set by `AuthProvider`) to bounce the user to login. Because the
access token is memory-only, a hard reload loses it — the wrapper silently re-mints one from
the sessionStorage refresh token on the first request. A one-time migration clears any legacy
`localStorage` refresh token so old "stay logged in across restarts" sessions can't survive.

### Auth endpoints

See the table in [backend.md](backend.md#auth--routes-authjs-mounted-at-apiauth):
`login`, `refresh`, `logout`, `logout-all`, `me`, `change-password`.

---

## Authorization (RBAC)

### The model

```
users ──*  user_roles  *── roles ──*  role_permissions  *── permissions
              │                                                  │
              │ scope (project_id / location_id / device_id      │ key e.g. 'device.start'
              │        — NULL = global)                          │
              ▼                                                  ▼
        a role grant can be global or scoped              permission keys are the
        to a project/location/device                      atoms guards check
```

A user holds **roles**; each role holds **permissions**; a role assignment (`user_roles`)
carries an optional **scope** (project / location / device — `NULL` = global).

### Built-in permission keys

From `rbac-defaults.js` `BUILTIN_PERMISSIONS`. These may be re-described but never
renamed/deleted (the route guards depend on them):

| Key | Meaning |
|---|---|
| `device.read` | View devices |
| `device.write` | Create/edit devices |
| `device.connect` | Connect to a device |
| `device.control` | Send commands to a device |
| `device.start` | Start a device |
| `device.stop` | Stop a device |
| `fuel.read` | View fuel readings |
| `alarm.read` | View alarms |
| `project.read` | View projects |
| `project.write` | Create/edit projects |
| `location.read` | View locations |
| `location.write` | Create/edit locations |
| `settings.read` | View settings |
| `settings.write` | Edit settings |
| `user.read` | View users & roles |
| `user.write` | Create/edit users |
| `user.assign_role` | Assign roles & permissions (also gates role/permission admin) |
| `audit.read` | View audit log |
| `datakom.read` | View live Datakom Rainbow data |
| `datakom.write` | Link/unlink Datakom devices, control the cloud adapter |

### Built-in system roles (`SYSTEM_ROLES`)

| Role | Scope | Permissions |
|---|---|---|
| **admin** (`Administrator`) | global | **ALL** built-in permissions |
| **viewer** (`Viewer`) | global | **ALL read-level** built-in permissions |
| **operator** (`Operator`) | global | `device.read`, `device.connect`, `device.control`, `device.start`, `device.stop`, `fuel.read`, `alarm.read`, `project.read`, `location.read`, `settings.read` |

System roles are seeded once by `ensureRbacSeed`; later admin edits to them are **not**
clobbered on restart.

### Permission implications

A stronger permission automatically satisfies the weaker ones it needs
(`PERMISSION_IMPLICATIONS` + `keysSatisfying`). Holding the key on the left satisfies a check
for any key on the right, transitively, at the same scope:

| Holding… | …also satisfies |
|---|---|
| `device.read` | `datakom.read`, `fuel.read` |
| `device.write` | `device.read` (→ `datakom.read`, `fuel.read`) |
| `device.connect` | `device.read` |
| `device.control` | `device.read`, `fuel.read` |
| `device.start` / `device.stop` | `device.read` |
| `datakom.read` | `fuel.read` |
| `datakom.write` | `datakom.read`, `device.read` |
| `project.write` | `project.read` |
| `location.write` | `location.read` |
| `settings.write` | `settings.read` |
| `user.write` | `user.read` |
| `user.assign_role` | `user.read` |

This is why, e.g., granting only `device.write` still lets a user *list* devices (otherwise
they could edit devices they can't see). The frontend keeps a mirror copy in
`config/uiElements.js` (`PERMISSION_IMPLICATIONS`) — **keep the two in sync**.

### Scoping

Roles can be granted globally or scoped to a project / location / device. On each request,
`_extractScope(req)` (`middleware.js:21`) pulls `project_id` / `location_id` / `device_id`
from the body, params, or query. `userHasPermission` / `_resolveScopeChain` (`auth.js`) then
**widen** that to the full chain — a device belongs to a location belongs to a project — so:

- a **global** grant (scope `NULL`) always passes, and
- a grant scoped to the project (or location, or the device itself) that the request targets
  also passes.

Permission results are cached per user; `invalidateUserPermsCache(userId)` clears it when a
user's roles/permissions change.

---

## Two enforcement layers

### 1. Static route guards (code)

Hard-coded on each route in `index.js` / `routes-users.js`:

- `requirePermission('x')` — 403 unless the user has `x` for the request's scope.
- `requireAnyPermission(['a','b'])` — passes if the user holds **any** of them (e.g. START is
  allowed by `device.start` *or* the legacy bundled `device.control`).
- `requirePermissionIfBodyPresent('datakom_did', 'datakom.write')` — adds a finer gate only
  when a specific body field is touched (linking a device to Datakom needs `datakom.write` on
  top of the base `device.write`).

These are listed per-endpoint in [backend.md](backend.md#http-endpoint-reference).

### 2. Dynamic UI-element → endpoint mapping (data)

Applied globally by `enforceMappedPermissions` (`middleware.js:194`, wired at `index.js:68`).
Admins can, **without a code change**, declare that a UI element maps to an endpoint pattern
and requires a permission. The middleware loads those mappings
(`_loadEndpoints`, cached; invalidated by `invalidateEndpointCache`), matches the request
path against the patterns (`_patternToRegex`), and blocks it if the (optionally
authenticated) user lacks the mapped permission.

Supporting tables/data:

- **`ui_element_catalog`** — the full list of buttons/controls, grouped by `field`
  (transcribed from `rbac-defaults.js` `UI_ELEMENT_CATALOG`). Seeded at startup.
- **`permission_ui_elements`** — permission → UI-element mappings (defaults from
  `defaultElementMappings()`; editable on the Permissions page).
- **`permission_endpoints`** — permission → endpoint-pattern mappings (managed via
  `/api/permissions/:id/endpoints`).

The **Permissions** and **Roles** admin pages (frontend) edit exactly this data; the
`/api/permissions/*` and `/api/roles/*` routes in `routes-users.js` are their backend. Reset
routes (`/api/permissions/reset`, `/api/roles/reset`) restore the `rbac-defaults.js` seed.

---

## Visibility filtering (`nav-scope.js`)

Authorization decides *whether an action is allowed*; **visibility** decides *which rows come
back*. After a handler queries devices/projects, `filterVisibleDevices(...)` drops anything
outside the user's scope, so a project-scoped user only ever sees their own devices in list
endpoints and in the live telemetry stream (`telemetry-ws.js` reuses the same filter).
