# Modbus Node.js Backend with Device Selection

## Overview
Node.js Express server for Modbus TCP communication with Oracle database integration. Now supports **manual device selection** - no longer auto-connects to first device.

## Quick Start

1. **Install dependencies:**
```bash
npm install
```

2. **Setup environment:**
```bash
copy .env.example .env
```
Edit `.env` with Oracle DB and Modbus defaults.

3. **Start server:**
```bash
npm start
```
Server runs on `http://localhost:3000`

## Key Features

### Device Management (NEW - Select specific devices!)
- `GET /api/devices` - **List all devices**
- `GET /api/modbus/connect?device_id=2` - **Connect to specific device**
- `GET /api/modbus/status` - **Check current connection**
- Full CRUD: POST/PUT/DELETE /api/devices/:id

### Modbus Controls
- `GET /api/modbus/start` - Start generator
- `GET /api/modbus/stop` - Stop generator  
- `GET /api/modbus/fuel` - Read fuel level
- `GET /api/modbus/disconnect` - Disconnect

### Example Workflow
```bash
# 1. List available devices
curl http://localhost:3000/api/devices

# 2. Connect to device ID 2 (not first device!)
curl "http://localhost:3000/api/modbus/connect?device_id=2"

# 3. Check status
curl http://localhost:3000/api/modbus/status

# 4. Control device
curl http://localhost:3000/api/modbus/start
curl http://localhost:3000/api/modbus/fuel

# 5. Disconnect when done
curl http://localhost:3000/api/modbus/disconnect
```

## Endpoints Summary

### Projects & Hierarchical Locations (NEW!)
- `GET /api/projects` - List projects
- `POST /api/projects` - Create project
- `GET /api/projects/:id/locations` - **Hierarchical tree** (recursive sub-locations, nested JSON)
- `POST /api/projects/:id/locations` - Create location (optional `parent_id`)
- `GET /api/locations/:id` - Single location w/ `parent_id`
- `PUT /api/locations/:id` - Update incl `parent_id`
- `DELETE /api/locations/:id`
- `GET /api/locations/:id/children` - **Direct sub-locations**
- `GET /api/project-tree` - Flat tree view (updated for hierarchy)

**Sub-location rules:** `parent_id` must be same `project_id`, names unique per parent/project.

### Device Actions Logging
- **Auto log** START/STOP to `DEVICE_ACTIONS`
- `GET /api/device-actions` - Recent actions

| Endpoint | Description |
|----------|-------------|
| `GET /` | Health check |
| `GET /api/devices` | List devices by location/project |
| `POST /api/devices` | Create w/ `location_id` |
| `GET /api/modbus/connect?device_id=<ID>` | Connect device |
| `GET /api/modbus/start` | Start + log action |
| `GET /api/modbus/stop` | Stop + log action |
| `GET /api/modbus/fuel` | Fuel % + log reading |
| `GET /api/project-tree` | **Hierarchical project view**

## Environment Variables
```
ORACLE_USER=your_user
ORACLE_PASSWORD=your_pass
ORACLE_HOST=localhost
ORACLE_PORT=1521
ORACLE_SERVICE_NAME=XE
MODBUS_IP=192.168.1.20
MODBUS_PORT=502
PORT=3000
```

## Project Structure
```
├── index.js              # Express server
├── modbus_connect.js     # Modbus logic + device selection
├── db.js                 # Oracle DB connection
├── package.json
├── TODO.md               # Progress tracking
└── README.md             # This file
```

## Recent Changes
- ✅ **No auto-connect to first device on startup**
- ✅ **Manual device selection via `?device_id=ID`**
- ✅ **New `/api/modbus/status` endpoint**
- ✅ **Enhanced connect endpoint with device config tracking**

Server now starts **disconnected** - perfect for multi-device environments!

## Frontend (NEW!)

Complete React dashboard at `./frontend/`:

**Run frontend:**
```
cd frontend
npm install
npm run dev
```
Opens `http://localhost:5173` - connects to backend APIs at `localhost:3000`.

**Features:**
- 📊 Dashboard: Fuel gauge (live poll), start/stop controls, registers table, stats charts
- 🔌 Connectivity: Device list, manual/device ID connect
- 📋 Events: Action log table
- 📱 Responsive + Tailwind UI + Sidebar navigation

Backend must run first (`npm start`).

## License
ISC
