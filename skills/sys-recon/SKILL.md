---
name: sys-recon
description: Full system baseline - hardware, software, OS, processes, services, disks. Read-only.
---
# Sys Recon
## System Info
```powershell
if (Test-Path bin\PsInfo64.exe) { bin\PsInfo64.exe -accepteula -d -h -s -c }
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture
hostname
$os = Get-CimInstance Win32_OperatingSystem
Write-Host "Last boot: $($os.LastBootUpTime)"
```
## Hardware
```powershell
Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors
Get-CimInstance Win32_PhysicalMemory | Measure-Object Capacity -Sum | ForEach-Object { Write-Host "RAM: $([math]::Round($_.Sum/1GB,1)) GB" }
Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, FileSystem, @{N='SizeGB';E={[math]::Round($_.Size/1GB,1)}}, @{N='FreeGB';E={[math]::Round($_.FreeSpace/1GB,1)}}
```
## Processes and Services
```powershell
if (Test-Path bin\pslist64.exe) { bin\pslist64.exe -accepteula -t } else { tasklist /FO CSV }
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 20 Name, Id, @{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB,1)}}, CPU
Get-CimInstance Win32_Service | Where-Object {$_.State -eq 'Stopped' -and $_.StartMode -eq 'Auto'} | Select-Object Name, DisplayName
if (Test-Path bin\PsService64.exe) { bin\PsService64.exe -accepteula query }
```
## Scheduled Tasks
```powershell
schtasks /query /fo CSV /nh | ConvertFrom-Csv | Where-Object {$_.TaskName -notlike "\\Microsoft\\*"} | Select-Object TaskName, Status
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
```
Save to artifacts/scout-reports/system-baseline.md.
