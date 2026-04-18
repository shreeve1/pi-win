---
name: sys-cleanup
description: Post-investigation cleanup. Removes temp files, orphan processes, and resets any diagnostic state. Run at end of every session.
---
# Sys Cleanup

Run at the end of every investigation session, before disconnecting from Live Connect.

## 1. Remove Temp Files
```powershell
# Remove files we created in $env:TEMP
$myTemp = Get-ChildItem $env:TEMP -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -like 'nmap.zip' -or $_.Name -like 'nmap-extract*' -or $_.Name -like 'node-install*' -or $_.Name -like 'pi-*'
}
if ($myTemp) {
    $myTemp | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue
    Write-Host "Cleaned $($myTemp.Count) temp files"
} else { Write-Host "No temp files to clean" }

# Check for stray downloads in common locations
@("$env:TEMP", "C:\working\pi\bin") | ForEach-Object {
    $stray = Get-ChildItem $_ -Filter "*.msi" -ErrorAction SilentlyContinue
    $stray += Get-ChildItem $_ -Filter "nmap*.zip" -ErrorAction SilentlyContinue
    if ($stray) { $stray | Remove-Item -Force -ErrorAction SilentlyContinue; Write-Host "Removed stray: $($stray.Name)" }
}
```

## 2. Kill Orphan Processes
```powershell
# Check for any nmap processes still running
$nmapProcs = Get-Process -Name "nmap","ncat","nping" -ErrorAction SilentlyContinue
if ($nmapProcs) {
    Write-Host "Killing orphan nmap processes: $($nmapProcs.Name)"
    $nmapProcs | Stop-Process -Force -ErrorAction SilentlyContinue
}

# Check for any node processes spawned by Pi that are stuck
# NOTE: do NOT kill the active pi session -- only orphans older than 30 min
```

## 3. Reset Diagnostic State
```powershell
# If any debug/trace logging was enabled, disable it
# Check for ETW trace sessions we may have started
$traces = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -match 'logman|tracelog|xperf'
}
if ($traces) {
    Write-Host "WARNING: Trace sessions still running. Manual cleanup needed."
    $traces | Select-Object Name, CommandLine
}

# If Windows Update was paused (some investigations do this), resume it
$wuKey = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings' -ErrorAction SilentlyContinue
if ($wuKey -and $wuKey.PauseFeatureUpdatesEndTime) {
    Write-Host "NOTE: Windows Update appears paused. Resume if not intentional."
}
```

## 4. Verify Firewall State
```powershell
# Check for any test firewall rules we created
$testRules = netsh advfirewall firewall show rule name=all dir=in | Select-String -Pattern "PI-TEST|PI-INVESTIGATE|PI-TEMP" -Context 2
if ($testRules) {
    Write-Host "WARNING: Test firewall rules found. Remove with:"
    Write-Host "  netsh advfirewall firewall delete rule name=`\"RULE_NAME`\""
}
```

## 5. Final Check
```powershell
# List anything we left running or changed
Write-Host "=== Cleanup Summary ==="
Write-Host "Temp files: cleaned"
Write-Host "Orphan processes: checked"
Write-Host "Firewall rules: checked"
Write-Host ""
Write-Host "Artifacts preserved at: C:\working\pi\artifacts\"
Write-Host "Investigation complete. Safe to disconnect."
```

## Notes
- NEVER delete anything in C:\working\pi\artifacts\ -- those are the investigation deliverables
- NEVER kill the pi agent process itself
- NEVER revert remediation changes that were APPROVED -- only clean up diagnostic state
- If investigation was aborted mid-Phase 4, document what was changed and what still needs rollback
