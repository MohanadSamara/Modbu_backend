# Deployment & operations

Two ways the app runs:

- **Production** — a Docker Compose stack (Oracle XE + Node backend + Caddy) on a Linux server.
- **Local / Windows** — `node index.js` on port 5400, optionally exposed via an ngrok or
  Cloudflare tunnel, often as a hidden scheduled task.

> The canonical step-by-step server setup is the root `DEPLOY.md`. This doc summarizes the
> topology and **flags the parts of `DEPLOY.md` that are now stale** (the agent tunnel).

---

## Production stack (Docker Compose)

```
Internet ──HTTPS──▶ Caddy ──▶ React frontend (static files in deploy/www)
                      │
                      ├─ /api/* ─▶ Node backend :5400 ─▶ Oracle XE (MODBUS_ADMIN)
                      └─ /ws/*  ─▶ Node backend :5400  (live telemetry)
```

### Services (`docker-compose.yml`)

| Service | Image | Notes |
|---|---|---|
| **oracle** | `gvenzl/oracle-xe:21` | Auto-creates the `MODBUS_ADMIN` app user on first start. Volume `oracle-data` persists the DB; `./deploy/db-dump` is mounted at `/dump` for Data Pump import. Healthcheck gates the backend start (5 min start period). |
| **backend** | built from `Dockerfile` | Node 20, `oracledb` in thin mode (no Oracle client). Reads `.env`, but **overrides** DB host/port/service to the compose network (`oracle` / `1521` / `XEPDB1`) and forces `PORT=5400`, `NODE_ENV=production`. Waits for `oracle` to be healthy. |
| **caddy** | `caddy:2` | Terminates HTTPS (auto-cert for `$DOMAIN`), serves the built frontend from `/srv/www`, reverse-proxies `/api/*` and `/ws/*` to `backend:5400`. Ports 80/443. |

Everything is one origin, so the frontend's relative `/api` and WebSocket paths work with **no
CORS setup** in production.

### Caddyfile (`deploy/Caddyfile`)

Routes: `/api/*` → backend, `/ws/*` → backend, everything else → the static React build
(`try_files … /index.html` SPA fallback).

> ⚠️ **Stale:** the `handle /agent-tunnel { reverse_proxy backend:5400 }` block still exists,
> but the agent tunnel was removed in `9d3ea6d` and the backend no longer serves that path.
> It's harmless (nothing connects) but can be deleted. See
> [modbus-and-device-io.md](modbus-and-device-io.md#agent-tunnel--historical).

### Bring-up (summary)

```bash
# on the server, once Docker + firewall (80/443/SSH) are set up
cd /opt/modbus
cp deploy/env.production.example .env   # fill every CHANGE_ME + DOMAIN + Datakom login
docker compose up -d --build
docker compose logs -f oracle           # wait for "DATABASE IS READY TO USE" (~5 min first run)
```

Build the frontend on your PC and upload it whenever it changes:

```bash
cd Modbus-front && npm run build
scp -r dist/* root@SERVER:/opt/modbus/deploy/www/
```

### Database import (one time)

The app does **not** create the core tables (users, devices, projects, …) — bring your
existing schema over with Oracle **Data Pump** (`expdp` on your PC → `impdp` in the oracle
container, schema `MODBUS_ADMIN`). Full commands in root `DEPLOY.md` step 6. A warning that
`MODBUS_ADMIN` already exists (ORA-31684) is normal. See
[database.md](database.md#two-classes-of-tables).

### Everyday commands

| What | Command |
|---|---|
| Status | `docker compose ps` |
| Backend logs | `docker compose logs -f backend` |
| Redeploy after code change | `docker compose up -d --build backend` |
| Stop (keep data) | `docker compose down` |

### Backups

Nightly Data Pump export via cron on the server (see root `DEPLOY.md`); dumps land in
`/opt/modbus/deploy/db-dump/`. Copy them off the server regularly.

---

## Environment file

Copy `deploy/env.production.example` → `.env` on the server. Key values (generate secrets with
`openssl rand -hex 32`): `DOMAIN`, `ORACLE_SYS_PASSWORD`, `ORACLE_PASSWORD`, `JWT_SECRET`,
`CORS_ORIGINS`, and the Datakom login (`DK_ENABLED`, `DK_USER`, `DK_PASS`). Full variable
table in [backend.md](backend.md#environment--configuration-reference).

> `AGENT_TOKEN` is still present in the example file but unused (agent tunnel removed).

---

## Local / Windows run

The backend listens on **port 5400** locally too.

| File | Purpose |
|---|---|
| `start-server.bat` | Starts `node index.js` **and** an ngrok tunnel on a reserved domain (`https://xerox-sketch-osmosis.ngrok-free.dev` → `localhost:5400`). |
| `start-cloudflare-tunnel.bat` | Alternative free Cloudflare quick tunnel to `localhost:5400` (prints a new random `*.trycloudflare.com` URL each run). Run only **one** tunnel at a time. |
| `_start_backend_hidden.vbs` | Launches `C:\node.exe index.js` with **no window** — used by the "Modbus Backend" scheduled task at logon, so the backend runs headless in the background. |

Because of the **single-instance guard** (`single-instance.js`), starting a second backend on
the same port refuses rather than double-running — important given the Datakom single-session
constraint ([datakom.md](datakom.md)).

> `_start_tunnel_hidden.vbs` is a leftover launcher for the removed agent tunnel.

### Exposing to the internet (dev)

`ngrok` (stable reserved domain, needs the saved authtoken) or `cloudflared` (no account,
random URL). Both simply forward a public HTTPS URL to `localhost:5400`. For real production,
use the Caddy stack above instead.

---

## Operational checklist

- [ ] `JWT_SECRET` is long & random (not the dev fallback).
- [ ] Datakom adapter runs from the **IP-allowlisted** host (port 464 is allowlisted by
      Datakom — otherwise the cloud connection resets before login).
- [ ] Exactly **one** backend instance per environment (single-session Datakom login).
- [ ] Nightly DB backups configured and copied off-box.
- [ ] Frontend rebuilt + uploaded after any frontend change.
