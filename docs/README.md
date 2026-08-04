# Modbus Hub — Documentation

Modbus Hub is a **permission-controlled platform for monitoring and controlling a fleet of
industrial generators** (and similar equipment). Devices are read over **Modbus TCP** or,
for Datakom-brand hardware, over **Datakom's Rainbow SCADA cloud**. Everything is organized
into a Projects → Locations → Devices hierarchy, backed by an Oracle database, and presented
through a React dashboard that receives **live telemetry over a WebSocket**.

The system is two git repositories:

| Repo | Path | Stack |
|---|---|---|
| **Backend** | `Desktop/Modbus` | Node.js + Express 5, Oracle DB, `ws` WebSockets |
| **Frontend** | `Desktop/FrontEndModbus/Modbus-front` | React 19 + Vite + Tailwind |

## Start here

Read [ARCHITECTURE.md](ARCHITECTURE.md) first for the big picture, then dive into whichever
subsystem you need.

## Table of contents

| Doc | What it covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System overview, topology diagram, request lifecycle, runtime rules |
| [backend.md](backend.md) | Every backend file + the full HTTP endpoint reference + env config |
| [database.md](database.md) | The Oracle `MODBUS_ADMIN` schema — tables, columns, relationships, migrations |
| [auth-rbac.md](auth-rbac.md) | JWT/refresh auth, the permission catalog, roles, scoping, two enforcement layers |
| [modbus-and-device-io.md](modbus-and-device-io.md) | Modbus connection engine, register decoding, live telemetry WebSocket |
| [datakom.md](datakom.md) | Datakom Rainbow cloud protocol, brand adapters, cloud→DB sync |
| [frontend.md](frontend.md) | The React dashboard — routes, pages, components, contexts, hooks |
| [deploy.md](deploy.md) | Docker/Caddy/Oracle hosting, Windows run, backups, operations |

## Documentation status

These docs describe the system **as of commit `9d3ea6d`** (the current `main`). Where the
older root `README.md` or `DEPLOY.md` disagree with the code, **these docs are authoritative**.
Notably:

- The **site-agent tunnel was removed** in `9d3ea6d`. The `agent/` folder now holds only
  leftover `node_modules`. `DEPLOY.md` step 8 still describes it — treat that as stale.
  See [modbus-and-device-io.md](modbus-and-device-io.md#agent-tunnel--historical).
- The backend listens on **port 5400** in the real Windows/scheduled-task setup, not the
  root README's `3000` (3000 is only the built-in default when nothing overrides it).
- The API is **fully authenticated** with fine-grained RBAC — the root README predates auth.
