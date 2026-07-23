' Launches the Modbus Node backend with no visible window.
' Called by the "Modbus Backend" scheduled task at logon.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\hosam\OneDrive\Desktop\Modbus"
' window style 0 = hidden; bWaitOnReturn = True keeps this host alive so node keeps running
sh.Run "C:\node.exe index.js", 0, True
