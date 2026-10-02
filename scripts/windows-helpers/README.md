# Windows helper scripts · Windows 輔助腳本

Each `.bat` is an ASCII launcher that asks for administrator rights and runs the matching `.ps1`
(UTF-8 with BOM so the Chinese messages render correctly). Double-click the `.bat`, click *Yes*.

| Script | Purpose |
|---|---|
| `允許防火牆-iPad儀表板.bat` → `firewall-setup.ps1` | Sets Public networks to Private and adds an inbound firewall rule for TCP 3801 (local subnet only). |
| `安裝溫度監測-LibreHardwareMonitor.bat` → `lhm-setup.ps1` | Registers `C:\Tools\LibreHardwareMonitor\LibreHardwareMonitor.exe` as an elevated logon task and starts it. Put `LibreHardwareMonitor.config` (remote web server on 8085) next to the exe first. |
| `保留埠號-修CPU溫度消失.bat` → `reserve-ports.ps1` | Fixes ports grabbed by Hyper-V/WSL: restores the default TCP dynamic port range (49152+), removes a stale 8085 exclusion, adds a URL ACL for `http://+:8085/`, restarts LibreHardwareMonitor. |
