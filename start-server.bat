@echo off
REM Starts the whole app: backend (which also serves the frontend) + public tunnel.
REM The tunnel now uses a STABLE ngrok domain that stays the same every launch:
REM
REM     https://xerox-sketch-osmosis.ngrok-free.dev
REM
REM (Reserved to your ngrok account. The authtoken is already saved on this PC via
REM  "ngrok config add-authtoken", so no login is needed here.)

cd /d "%~dp0"
start "Modbus Backend (do not close)" cmd /k node index.js

REM Give the backend a few seconds to come up before exposing it
timeout /t 6 /nobreak >nul

start "Public Tunnel (do not close)" cmd /k ngrok http --domain=xerox-sketch-osmosis.ngrok-free.dev 5400

echo.
echo Both windows started.
echo Your PERMANENT public URL is: https://xerox-sketch-osmosis.ngrok-free.dev
echo.
pause
