# Frontend

The dashboard is a **React 19 single-page app** (repo:
`Desktop/FrontEndModbus/Modbus-front`), built with **Vite** and styled with **Tailwind CSS**.
It talks to the backend over the REST API and the `/ws/telemetry` WebSocket.

## Stack & how it's served

| Concern | Choice |
|---|---|
| Framework | React `^19.2` |
| Router | `react-router-dom` `^6.30` |
| Build | Vite `^8` (`npm run dev` / `npm run build` / `npm run preview`) |
| Styling | Tailwind CSS `^3.4` (+ PostCSS/autoprefixer) |
| Charts | `recharts` `^2.15` |
| Map | `leaflet` + `react-leaflet` `^5` |
| Animation | `framer-motion` `^12` (globally `reducedMotion="user"`) |

- **Dev:** `npm run dev` serves on `http://localhost:5173` (a backend CORS default origin) and
  proxies API calls to the backend (see `vite.config.js`).
- **Production:** `npm run build` emits `dist/`, which is copied to the server (`deploy/www/`)
  and served — either by Caddy or by the backend's own static handler (which SPA-falls-back to
  `index.html` for non-`/api`/`/ws` paths). See [deploy.md](deploy.md).

## Entry & providers

`main.jsx` renders `<App/>`. `App.jsx` composes the provider stack and the router:

```
<BrowserRouter>
  <ErrorBoundary>
    <MotionConfig reducedMotion="user">      ← strips animation for OS reduce-motion users
      <FeedbackProvider>                     ← global toast/feedback
        <AuthProvider>                       ← current user, tokens, login/logout
          <SettingsProvider>                 ← system settings + theming
            <PageEditProvider>               ← in-app page-content editor state
              <Routes> … </Routes>
```

## Routes → pages → required permission (`App.jsx`)

`/login` is public. Everything else is nested under a `ProtectedRoute` + `Layout` shell; most
child routes add their own `ProtectedRoute` permission gate.

| Path | Page | Required permission |
|---|---|---|
| `/` (index) | `Dashboard` | (authenticated) |
| `/connections` | `DeviceConnections` | `device.read` |
| `/brands` | `Brands` | `device.read` |
| `/datakom` | `DatakomConnection` | any `datakom.read` \| `device.read` |
| `/alarms` | `Alarms` | `alarm.read` |
| `/fuel` | `FuelLevels` | `fuel.read` |
| `/map` | `DeviceMapPage` | `device.read` |
| `/events` | `Events` | `alarm.read` |
| `/projects` | `Projects` | any `project.read` \| `device.read` |
| `/settings` | `Settings` | `settings.read` |
| `/users` | `Users` | `user.read` |
| `/audit` | `AuditLog` | `audit.read` |
| `/roles` | `Roles` | `user.assign_role` |
| `/permissions` | `Permissions` | `user.assign_role` |
| `*` | `NotFound` | — |

These gates mirror the backend route guards ([backend.md](backend.md)); the backend remains
the real enforcer — the frontend gates are for UX (hide what you can't use).

## Directory tour (`src/`)

### `pages/`
One file per route above. Notable ones:
- `Dashboard.jsx` — fuel gauges, controls, live overview.
- `DeviceConnections.jsx` — connect/manage device connections.
- `Brands.jsx` / `DatakomConnection.jsx` — brand adapters + the Datakom cloud live panel and
  connection controls.
- `Projects.jsx` — the Projects → Locations → Devices tree (with `ProjectsSidebar`).
- `Users.jsx` / `Roles.jsx` / `Permissions.jsx` / `AuditLog.jsx` — the RBAC admin surface
  (edits the data described in [auth-rbac.md](auth-rbac.md)).
- `FuelLevels.jsx`, `Alarms.jsx`, `Events.jsx`, `DeviceMapPage.jsx`, `Settings.jsx`.

### `components/`
- `Layout.jsx` — app shell (sidebar/nav/header).
- `ProtectedRoute.jsx` — auth + permission gate for routes (`requiredPermission` /
  `requiredAnyPermission`).
- `Can.jsx` — declarative permission gate for individual UI elements (renders children only
  if the user holds the permission). The element-level mirror of the backend RBAC.
- `FuelGauge.jsx` — the fuel dial. `ControlButtons.jsx` — start/stop controls.
- `DeviceMap.jsx` — Leaflet map of device GPS positions.
- `DatakomLivePanel.jsx` / `DatakomDeviceLive.jsx` — live Datakom cloud readings.
- `CommandPalette.jsx` — quick-nav/search palette (powered by `config/searchIndex.jsx`).
- `RolePermissionsEditor.jsx` — the role ↔ permission matrix editor.
- `ProjectsSidebar.jsx`, `Skeleton.jsx` (loading), `ErrorBoundary.jsx`.
- `anim/` — animation helpers; `pageedit/` — in-app page-content editing UI;
  `styleseed/` — theming/branding.

### `api/`
- `http.js` — the single `fetch` wrapper: injects the in-memory access token, transparently
  refreshes on 401 and retries once, parses JSON / throws rich errors, stores the refresh
  token in `sessionStorage`. See [auth-rbac.md](auth-rbac.md#client-side-flow-apihttpjs).
- `auth.js`, `modbus.js`, `projects.js`, `brands.js`, `datakom.js`, `settings.js` — typed
  per-domain clients built on `http.js`.

### `context/`
- `AuthContext.jsx` (+ `useAuth.js`) — holds the user, tokens, `login`/`logout`; wires
  `http.js`'s `onAuthFailed`.
- `SettingsContext.jsx` — system settings + theming.
- `FeedbackContext.jsx` (+ `useFeedback.js`) — global toast/notification feedback.
- `PageEditContext.jsx` (+ `pageEditDom.js`) — the live page-content editor (persists via
  `PUT /api/page-content`).

### `hooks/`
- `useTelemetry.js` — subscribes to the backend `/ws/telemetry` WebSocket and exposes live
  fuel/consumption/alarm/GPS updates to components (replaces polling).
- `useAlarmSound.js` — plays the alarm sound on active alarms (mutable/muteable).
- `useScrollToHash.js` — scroll-to-anchor on navigation.

### `config/`
- `apiEndpoints.js` — endpoint constants.
- `navItems.jsx` — sidebar navigation definition (per-item permissions).
- `searchIndex.jsx` — command-palette index.
- `uiElements.js` — the frontend mirror of the RBAC UI-element catalog **and**
  `PERMISSION_IMPLICATIONS`; **must be kept in sync** with `rbac-defaults.js` on the backend.
- `uiFeatures.js` — feature-flag/toggle definitions (`/api/ui-features`).

### `lib/`
- `dedupeDevices.js` — de-duplicates device lists (e.g. a device present both as a DB row and
  a cloud entry).
- `motion.js` — shared framer-motion variants.

## Real-time & auth summary

- **Live data:** `hooks/useTelemetry.js` ↔ backend `telemetry-ws.js` over `/ws/telemetry`
  (token passed as `?token=`). See [modbus-and-device-io.md](modbus-and-device-io.md#live-telemetry-websocket-telemetry-wsjs).
- **Auth:** access token in memory, refresh token in `sessionStorage` (clears on tab close),
  auto-refresh on 401. See [auth-rbac.md](auth-rbac.md).
