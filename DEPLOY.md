# Hosting guide — Modbus Hub

One server runs everything with Docker:

```
Internet ──HTTPS──▶ Caddy ──▶ React frontend (static files)
                      │──▶ /api, /ws, /agent-tunnel ──▶ Node backend ──▶ Oracle XE
Site LANs ──outbound WSS──▶ /agent-tunnel (agents reach your Modbus devices)
```

Your Modbus devices keep working because the site agent (`agent/` folder)
dials OUT to the server — no VPN or port-forwarding at the sites.

---

## What you need

1. **A Linux server** — Ubuntu 22.04/24.04, **4 GB RAM minimum** (Oracle XE
   alone needs ~2 GB). Examples:
   - Hetzner CX32 / DigitalOcean 4GB droplet (~$8–12/month), or
   - Oracle Cloud "Always Free" ARM VM ($0/month — pick the
     `VM.Standard.A1.Flex` shape, 4 OCPU / 24 GB).
2. **A domain name** (~$10/year) with an **A record** pointing at the
   server's public IP (e.g. `fuel.yourcompany.com → 203.0.113.10`).
   HTTPS is automatic after that — no certificate work.

## Step 1 — Prepare the server (once)

SSH in as root and run:

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

# Firewall: only web + SSH
apt-get install -y ufw
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

## Step 2 — Copy the project to the server

From your Windows PC (PowerShell), copy the backend folder:

```powershell
scp -r "C:\Users\hosam\OneDrive\Desktop\Modbus" root@YOUR_SERVER_IP:/opt/modbus
```

(or `git clone` your repository on the server instead).

## Step 3 — Build the frontend and upload it

On your PC:

```powershell
cd C:\Users\hosam\OneDrive\Desktop\FrontEndModbus\Modbus-front
npm run build
scp -r dist\* root@YOUR_SERVER_IP:/opt/modbus/deploy/www/
```

Repeat these two commands every time you change the frontend.

## Step 4 — Configure secrets

On the server:

```bash
cd /opt/modbus
cp deploy/env.production.example .env
nano .env     # fill in every CHANGE_ME + your domain + Datakom login
```

Generate strong values with `openssl rand -hex 32`.

## Step 5 — Start everything

```bash
cd /opt/modbus
docker compose up -d --build
docker compose logs -f oracle   # wait until "DATABASE IS READY TO USE"
```

First start takes ~5 minutes (Oracle initializes its data files).

## Step 6 — Copy your database (one time)

The app does NOT create the core tables (users, devices, projects…), so copy
your existing local database with Oracle Data Pump.

**On your PC** (where Oracle XE runs now):

```powershell
mkdir C:\dump
sqlplus system@localhost:1521/XEPDB1
SQL> CREATE OR REPLACE DIRECTORY dump_dir AS 'C:\dump';
SQL> exit

expdp system@localhost:1521/XEPDB1 schemas=MODBUS_ADMIN directory=dump_dir dumpfile=modbus.dmp logfile=exp.log
scp C:\dump\modbus.dmp root@YOUR_SERVER_IP:/opt/modbus/deploy/db-dump/
```

**On the server:**

```bash
cd /opt/modbus
docker compose exec oracle sqlplus system/YOUR_ORACLE_SYS_PASSWORD@XEPDB1 <<'SQL'
CREATE OR REPLACE DIRECTORY dump_dir AS '/dump';
SQL

docker compose exec oracle impdp system/YOUR_ORACLE_SYS_PASSWORD@XEPDB1 \
  schemas=MODBUS_ADMIN directory=dump_dir dumpfile=modbus.dmp logfile=imp.log

docker compose restart backend
```

Note: a warning that user `MODBUS_ADMIN` already exists (ORA-31684) is normal
— the tables and data still import.

## Step 7 — Open the app

Go to `https://your-domain` and sign in with your existing users
(they came over with the database import).

## Step 8 — Connect the sites (agents)

On each site's small always-on machine (mini PC / Raspberry Pi on the same
LAN as the Modbus device) — see `agent/README.md`:

```
SERVER_URL=wss://your-domain
AGENT_TOKEN=<same value as the server .env>
DEVICE_ID=<device_id from the database>
DEVICE_IP=<the device's LOCAL ip, e.g. 192.168.1.10>
```

The moment the agent connects, the server automatically routes that device
through the tunnel.

---

## Everyday commands (on the server)

| What | Command |
|---|---|
| See status | `docker compose ps` |
| Backend logs | `docker compose logs -f backend` |
| Restart after code change | `docker compose up -d --build backend` |
| Stop everything | `docker compose down` (data is kept) |

## Backups (important for production)

Nightly database export — add to `crontab -e` on the server:

```
0 3 * * * cd /opt/modbus && docker compose exec -T oracle expdp system/YOUR_ORACLE_SYS_PASSWORD@XEPDB1 schemas=MODBUS_ADMIN directory=dump_dir dumpfile=backup_$(date +\%F).dmp reuse_dumpfiles=y > /dev/null 2>&1
```

Backups land in `/opt/modbus/deploy/db-dump/`. Copy them off the server
regularly (e.g. download weekly to your PC).
