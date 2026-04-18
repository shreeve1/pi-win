---
name: sys-software
description: Software/config audit - installed programs, updates, drivers, GPO, registry. Read-only.
---
# Sys Software
## Installed Programs
```powershell
@('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*') | ForEach-Object {
    Get-ItemProperty $_ -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName} | Select-Object DisplayName, DisplayVersion, Publisher, InstallDate
} | Sort-Object DisplayName
```
## Updates and Drivers
```powershell
Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 20 HotFixID, Description, InstalledOn
driverquery /v /fo CSV | ConvertFrom-Csv | Select-Object 'Display Name', Module, 'Driver Type', Path
```
## GPO
```powershell
gpresult /Scope Computer /V 2>&1 | Out-String
```
## Pending Windows Updates
```powershell
# Check for pending updates via COM object
$session = New-Object -ComObject Microsoft.Update.Session -ErrorAction SilentlyContinue
if ($session) {
    $searcher = $session.CreateUpdateSearcher()
    $result = $searcher.Search('IsInstalled=0') -ErrorAction SilentlyContinue
    if ($result) {
        Write-Host "Pending updates: $($result.Updates.Count)"
        $result.Updates | Select-Object Title, Description, IsMandatory | Format-Table -AutoSize
    }
}
# Check for pending reboot after updates
$pendingReboot = $false
if (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending' -ErrorAction SilentlyContinue) { $pendingReboot = $true }
if (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired' -ErrorAction SilentlyContinue) { $pendingReboot = $true }
Write-Host "Reboot pending: $pendingReboot"
```
## Printers and Peripherals
```powershell
# Installed printers
Get-Printer -ErrorAction SilentlyContinue | Select-Object Name, Type, DriverName, PortName, PrinterStatus
Get-PrintJob -ErrorAction SilentlyContinue | Select-Object PrinterName, Name, JobStatus, SubmittedTime
# USB devices
Get-CimInstance Win32_USBControllerDevice -ErrorAction SilentlyContinue | ForEach-Object { $_.Dependent } | Select-Object Name, DeviceID, Status
# Connected monitors
Get-CimInstance Win32_DesktopMonitor -ErrorAction SilentlyContinue | Select-Object Name, MonitorType, ScreenHeight, ScreenWidth
# Audio devices
Get-CimInstance Win32_SoundDevice -ErrorAction SilentlyContinue | Select-Object Name, Status
```
## Registry
```powershell
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' | Select-Object ProductName, DisplayVersion, CurrentBuild, UBR
if (Test-Path bin\PsInfo64.exe) { bin\PsInfo64.exe -accepteula -s -c }
```
Save to artifacts/scout-reports/software-audit.md.
