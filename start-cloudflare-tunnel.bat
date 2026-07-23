@echo off
REM Starts a FREE Cloudflare quick tunnel to the backend (port 5400).
REM No account, no domain, no config needed. Every launch prints a NEW random
REM public URL like:  https://xxxx-yyyy.trycloudflare.com
REM (the URL changes each run — copy it from the window below and share it).
REM
REM NOTE: run only ONE tunnel at a time — if the ngrok tunnel (start-server.bat
REM or the "Modbus Tunnel" scheduled task) is running too, both will work but
REM you probably only need one.

"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:5400
pause
