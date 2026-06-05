# Windows / PowerShell 5.1 Reference

On-demand reference for the pi-win investigation agent. Read this when you need
cmdlet syntax, WMI/CIM classes, encoding gotchas, or tool invocation details.
Not loaded into the agent prompt by default -- pull it in when relevant.

## CimInstance / WMI

### ConvertToDateTime is NOT a method on CimInstance
```powershell
# BROKEN - ConvertToDateTime is a ScriptMethod on WMI objects, not CimInstance
$os.ConvertToDateTime($os.LastBootUpTime)   # Error: MethodNotFound

# FIX - CimInstance properties are already .NET DateTime objects
$os = Get-CimInstance Win32_OperatingSystem
$os.LastBootUpTime                          # Returns DateTime directly
```

### Get-CimInstance vs Get-WmiObject
- `Get-CimInstance` is preferred (modern, same results in PS 5.1)
- CimInstance returns .NET native types (DateTime, etc.)
- WmiObject returns WMI wrapper types with helper methods like ConvertToDateTime
- Both require admin for full visibility on some classes

### WMI Event Subscriptions -- Get-WmiObject is REQUIRED
`Get-CimInstance` CANNOT query WMI event subscriptions. For security/forensic checks of WMI persistence, you MUST use:
```powershell
Get-WmiObject -Class __FilterToConsumerBinding -Namespace root\subscription -ErrorAction SilentlyContinue
Get-WmiObject -Class __EventFilter -Namespace root\subscription -ErrorAction SilentlyContinue
Get-WmiObject -Class CommandLineEventConsumer -Namespace root\subscription -ErrorAction SilentlyContinue
```
This is the one case where `Get-WmiObject` is required over `Get-CimInstance`.

### Common WMI Classes
```powershell
Get-CimInstance Win32_OperatingSystem                    # OS info, last boot
Get-CimInstance Win32_Processor                           # CPU
Get-CimInstance Win32_PhysicalMemory                      # RAM sticks
Get-CimInstance Win32_LogicalDisk                         # Drives
Get-CimInstance Win32_Service                             # Services
Get-CimInstance Win32_Process                             # Processes
Get-CimInstance Win32_StartupCommand                      # Startup items
Get-CimInstance Win32_NetworkAdapter                      # NICs
Get-CimInstance Win32_NetworkAdapterConfiguration         # IP config
```

### Installed Software -- NEVER use Win32_Product
```powershell
# Win32_Product triggers MSI reconfig -- VERY slow and causes side effects
# AVOID: Get-CimInstance Win32_Product

# USE INSTEAD: Registry (fast, no side effects)
Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
    Select-Object DisplayName, DisplayVersion, Publisher, InstallDate
# Also check 32-bit on 64-bit:
Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
    Select-Object DisplayName, DisplayVersion, Publisher, InstallDate
```

## Encoding

```powershell
# Out-File defaults to Unicode (UTF-16LE). Set-Content defaults to ANSI.
# ALWAYS use -Encoding UTF8 for plain text files.
"content" | Out-File -FilePath "file.txt" -Encoding UTF8
"content" | Set-Content -Path "file.txt" -Encoding UTF8

# Invoke-WebRequest: always add -UseBasicParsing (avoids IE DOM dependency, broken on Server Core)
Invoke-WebRequest -Uri "https://example.com" -UseBasicParsing

# $OutputEncoding defaults to ASCII in PS 5.1 -- mangles UTF-8 output to native commands
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Some PS 5.1 cmdlets emit UTF-8 BOM -- can corrupt parsing
# Use [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 if needed
```

## Paths

```powershell
# Backslashes in commands
bin\pslist64.exe       # CORRECT
bin/pslist64.exe       # May work but inconsistent

# Quote paths with spaces
"C:\Program Files\Something\app.exe"

# MAX_PATH is 260 chars -- use \\?\ prefix for long paths
Get-Content "\\?\C:\very\long\path\..."

# $env:TEMP is usually C:\Windows\Temp when running as SYSTEM
# $env:USERPROFILE is C:\Windows\System32\config\systemprofile as SYSTEM
```

## Running as SYSTEM (NT AUTHORITY\SYSTEM)

- No user profile loaded, `$env:USERPROFILE` = `C:\Windows\System32\config\systemprofile`
- No network drives mapped -- use UNC paths or full local paths
- HKCU: maps to SYSTEM account hive (S-1-5-18), NOT any logged-on user or .DEFAULT
- ENV vars differ from user session -- check with `Get-ChildItem Env: | Format-Table Name, Value`
- npm/node global installs go to system-wide location

## Execution Policy

```powershell
# Check current policy
Get-ExecutionPolicy    # May be Restricted or RemoteSigned

# Bypass for current process only (no persistence)
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

# Or use -ExecutionPolicy Bypass on the command line
powershell.exe -ExecutionPolicy Bypass -File script.ps1
```

## Command Equivalents

| Unix | PowerShell / Windows |
|------|---------------------|
| `cat file` | `Get-Content file` |
| `tail -n 20 file` | `Get-Content file -Tail 20` |
| `grep pattern file` | `Select-String -Pattern "pattern" -Path file` |
| `grep -r pattern dir/` | `Get-ChildItem -Recurse dir \| Select-String "pattern"` |
| `ping host` | `Test-Connection host -Count 4` |
| `traceroute host` | `Test-NetConnection host -TraceRoute` |
| `netstat -an` | `netstat -an` (still works) |
| `ps aux` | `Get-Process \| Format-Table` |
| `kill PID` | `Stop-Process -Id PID` |
| `which command` | `Get-Command command` |
| `df -h` | `Get-Volume` or `Get-CimInstance Win32_LogicalDisk` |
| `find / -name file` | `Get-ChildItem -Recurse -Filter "file" -ErrorAction SilentlyContinue` |
| Pipe objects to text | `\| Out-String` |

## Nmap (bin\nmap directory)

Nmap 7.92 portable zip -- extracted by install script, no installer or registry entries.

```powershell
# IMPORTANT: No Npcap installed -- only connect scan works (-sT, which is default for non-root)
# SYN scan (-sS) NOT available without Npcap driver

# Port scan (top 1000 ports, default)
bin\nmap\nmap.exe -sT target

# Scan specific ports
bin\nmap\nmap.exe -sT -p 22,80,443,3389,445,135 target

# Scan subnet
bin\nmap\nmap.exe -sT -p 22,80,443,3389,445 192.168.1.0/24

# Service version detection
bin\nmap\nmap.exe -sT -sV -p 443,80 target

# Ping sweep (host discovery)
bin\nmap\nmap.exe -sn 192.168.1.0/24

# Fast scan (top 100 ports)
bin\nmap\nmap.exe -sT -F target

# Output to file
bin\nmap\nmap.exe -sT -oN "artifacts\\investigations\\nmap-scan.txt" target

# Ncat (netcat replacement)
bin\nmap\ncat.exe -zv target 443            # Port test
bin\nmap\ncat.exe target 80               # Connect to port

# Nping (packet generator)
bin\nmap\nping.exe --tcp -p 443 target    # TCP probe
```

**Limitations without Npcap:**
- No SYN scan (-sS) -- use connect scan (-sT) instead
- No raw packet operations -- some OS detection features limited
- No ARP scanning on local network
- Connect scan is slower but reliable and sufficient for investigation

## Sysinternals (bin\ directory)

```powershell
# ALWAYS use -accepteula flag or they hang waiting for EULA dialog
bin\pslist64.exe -accepteula        # Process list (tree view with -t)
bin\PsService64.exe -accepteula query  # Service list
bin\PsInfo64.exe -accepteula -d -h -s -c  # System info (CSV)
bin\autorunsc64.exe -accepteula -a * -c  # Autostart entries (CSV)
bin\tcpvcon64.exe -accepteula -a -c  # TCP connections (CSV)
bin\handle64.exe -accepteula -s     # Open handles
bin\sigcheck64.exe -accepteula -h -a -c [path]  # File signatures
bin\psloglist64.exe -accepteula     # Event log query
bin\Listdlls64.exe -accepteula -u   # DLL list (unsigned only)

# Check first: if (Test-Path bin\pslist64.exe) { ... }
# If missing, fall back to built-in equivalents (tasklist, netstat, sc.exe)
# CSV output (-c flag) is best for parsing
# Some tools require admin for full visibility
```

## Event Logs

```powershell
# Get-WinEvent preferred over deprecated Get-EventLog
# Use -FilterHashtable for performance (not string filtering)
Get-WinEvent -FilterHashtable @{LogName='System'; Level=2; StartTime=(Get-Date).AddHours(-24)} -ErrorAction SilentlyContinue

# Common log names: System, Application, Security, Setup, ForwardedEvents
# Security log (4624/4625) requires admin rights
# Always add -ErrorAction SilentlyContinue when log may not exist or access denied
```

## Registry

```powershell
# PSDrives: HKLM:\ and HKCU:\
Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" -ErrorAction SilentlyContinue

# Check key exists
Test-Path "HKLM:\SOFTWARE\MyApp"

# Fallback if PS providers fail
reg.exe query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run"

# Remember: HKCU as SYSTEM = S-1-5-18 hive, NOT the logged-on user
```

## File Operations

```powershell
# Hidden/system files
Get-ChildItem -Force C:\SomeDir

# Recursive with error suppression (ALWAYS add -ErrorAction SilentlyContinue)
Get-ChildItem -Recurse C:\SomeDir -ErrorAction SilentlyContinue

# Checksums
Get-FileHash C:\file.exe          # SHA256 default
Get-FileHash C:\file.exe -Algorithm MD5

# Pipe rich objects to text when needed
Get-Process | Out-String
```

## Networking

```powershell
# Ping
Test-Connection host -Count 4 -Quiet    # -Quiet returns boolean

# Port test
Test-NetConnection host -Port 443

# Traceroute
Test-NetConnection host -TraceRoute

# HTTP check
Invoke-WebRequest -Uri "https://example.com" -UseBasicParsing -TimeoutSec 10

# Firewall
netsh advfirewall show allprofiles
netsh advfirewall firewall show rule name=all
```

## Additional Gotchas

- **wmic is deprecated** after Windows 10 21H1 / Server 21H2. Prefer `Get-CimInstance` or native PS cmdlets. Still works on most systems but may be removed in future builds.
- **ConvertFrom-Csv** parses CSV from native commands (`schtasks`, `driverquery`) -- watch encoding on non-English systems.
- **Always add** `-ErrorAction SilentlyContinue` on commands that may fail (access denied, missing logs).
- **Access denied is normal** -- many commands require admin. If not elevated, wrap in try/catch or add `-ErrorAction SilentlyContinue` and continue. Never abort the whole investigation on a single access denied.
- **Empty results are not errors** -- if a command returns nothing, it may mean no matching items (e.g., no failed services). Continue to next check.
- **Test-Path before tool use** -- always check `if (Test-Path bin\tool64.exe)` before calling Sysinternals. Fall back to built-in equivalents if missing.
- **Long-running commands** -- add `-TimeoutSec` to web requests, avoid commands that run indefinitely (nmap without port limit on wide subnets).

## Discovered Issues Log

| Date | Issue | Fix |
|------|-------|-----|
| 2026-04-14 | Built-in bash tool fails silently on Windows (no /bin/sh) | Fixed via powershell-bash extension |
| 2026-04-14 | ConvertToDateTime not available on CimInstance objects | Use `$os.LastBootUpTime` directly (already DateTime) |
