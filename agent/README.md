# Modbus Site Agent (reverse tunnel)

Connect remote Datakom D‑500 devices to the central server **without a VPN or
public IP**. The agent runs at the site, reads the local device over its LAN,
and dials **out** to the server over one WebSocket tunnel. The server sends
read/command requests back down that tunnel.

Because the connection is outbound, the site needs only ordinary internet — no
inbound ports, no static IP. Overlapping `192.168.x` subnets across sites don't
matter: the server addresses devices by `device_id`.

```
site LAN                          internet                central server
┌─────────────────────┐                                  ┌──────────────────┐
│ D‑500 (192.168.1.10) │◀── Modbus TCP ──┐                │ index.js         │
│                      │                 │  outbound WSS  │  + remote-hub.js │
│ agent.js ────────────┼─────────────────┴───────────────▶│  /agent-tunnel   │
└─────────────────────┘                                  └──────────────────┘
```

## Server side (already wired in)

1. Set a shared secret in the server `.env`:
   ```
   AGENT_TOKEN=<long-random-string>
   ```
2. Restart the server. It logs: `[RemoteHub] Agent tunnel listening at /agent-tunnel`.
3. In production, terminate TLS at your reverse proxy and expose the tunnel as
   `wss://your-server/agent-tunnel`.

A device becomes "remote" automatically the moment its agent connects; if no
agent is present the server falls back to direct Modbus TCP (unchanged behaviour).

## Per site

1. Copy this `agent/` folder to a small always‑on machine on the device's LAN
   (mini PC, Raspberry Pi, industrial gateway).
2. `cp .env.example .env` and fill in:
   - `SERVER_URL` — `wss://your-server` (or `ws://host:3000` for local testing)
   - `AGENT_TOKEN` — must match the server
   - `AGENT_ID` — a name for the site
   - `DEVICE_ID` — must equal the `device_id` in the server database
   - `DEVICE_IP` / `DEVICE_PORT` — the device's **local** address at this site
3. Install and run:
   ```
   npm install
   npm start
   ```
   Expect: `✓ Tunnel open`, then `✓ Connected local device <id>`.

To keep it running, use a service manager (`systemd`, `pm2`, or Windows Task
Scheduler / NSSM).

## Multiple devices at one site

```
DEVICES=[{"deviceId":1,"ip":"192.168.1.10","port":502},{"deviceId":2,"ip":"192.168.1.11","port":502}]
```

## Notes

- The Modbus register map lives in `../shared/modbus-registers.js`, shared with
  the server so the two never drift.
- The tunnel auto‑reconnects with backoff; the local device auto‑reconnects on
  the next request and on a 15 s heartbeat.
