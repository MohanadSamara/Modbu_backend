' Launches the ngrok tunnel (stable domain from ngrok.yml) with no visible window.
' Called by the "Modbus Tunnel" scheduled task at logon.
Set sh = CreateObject("WScript.Shell")
' window style 0 = hidden; bWaitOnReturn = True keeps this host alive so ngrok keeps running
sh.Run """C:\Users\hosam\AppData\Local\Microsoft\WinGet\Links\ngrok.exe"" start --all", 0, True
