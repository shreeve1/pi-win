---
name: sys-security
description: Security - persistence, suspicious processes, unsigned files, security events. Read-only.
---
# Sys Security
## Persistence
```powershell
if (Test-Path bin\autorunsc64.exe) {
    bin\autorunsc64.exe -accepteula -a * -c -h
    bin\autorunsc64.exe -accepteula -a * -u -m -c
} else {
    Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
    Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
}
schtasks /query /fo CSV /nh | ConvertFrom-Csv | Where-Object {$_.TaskName -notlike "\\Microsoft\\*"} | Select-Object TaskName, Status
# NOTE: Get-WMIObject is required here -- Get-CimInstance cannot query WMI event subscriptions
Get-WMIObject -Class __FilterToConsumerBinding -Namespace root\subscription -ErrorAction SilentlyContinue
Get-WMIObject -Class __EventFilter -Namespace root\subscription -ErrorAction SilentlyContinue
Get-WMIObject -Class CommandLineEventConsumer -Namespace root\subscription -ErrorAction SilentlyContinue
```
## Suspicious Processes
```powershell
if (Test-Path bin\pslist64.exe) { bin\pslist64.exe -accepteula -t -x } else { tasklist /V /FO CSV }
Get-Process | Where-Object {$_.Path -and $_.Path -match 'Temp|AppData|Downloads|Public'} | Select-Object Name, Id, Path
if (Test-Path bin\Listdlls64.exe) { bin\Listdlls64.exe -accepteula -u }
```
## Signatures
```powershell
if (Test-Path bin\sigcheck64.exe) { bin\sigcheck64.exe -accepteula -h -a -c [path] }
Get-FileHash [path] -Algorithm SHA256
```
## Security Events
```powershell
Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4625} -MaxEvents 20 -ErrorAction SilentlyContinue
if (Test-Path bin\psloglist64.exe) { bin\psloglist64.exe -accepteula -o Security -n 100 -f e,w }
```
## Handles and Network
```powershell
if (Test-Path bin\handle64.exe) { bin\handle64.exe -accepteula -s }
if (Test-Path bin\tcpvcon64.exe) { bin\tcpvcon64.exe -accepteula -a -c } else { netstat -bno }
```
Save to artifacts/investigations/security-analysis.md with severity ratings.
