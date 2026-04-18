---
name: sys-performance
description: Performance profiling - CPU, memory, disk, boot time, event errors. Read-only.
---
# Sys Performance
## CPU
```powershell
Get-Process | Sort-Object CPU -Descending | Select-Object -First 20 Name, Id, @{N='CPU_s';E={[math]::Round($_.CPU,1)}}, @{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB,1)}}
Write-Host "CPU Load: $((Get-CimInstance Win32_Processor).LoadPercentage)%"
```
## Memory
```powershell
$os = Get-CimInstance Win32_OperatingSystem
$totalGB = [math]::Round($os.TotalVisibleMemorySize/1MB, 1)
$freeGB = [math]::Round($os.FreePhysicalMemory/1MB, 1)
$usedPct = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory)/$os.TotalVisibleMemorySize*100, 1)
Write-Host "Memory: ${usedPct}% used (${freeGB}GB free of ${totalGB}GB)"
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 20 Name, @{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB,1)}}
Get-CimInstance Win32_PageFileUsage | Select-Object Name, AllocatedBaseSize, CurrentUsage, PeakUsage
```
## Disk
```powershell
Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, @{N='TotalGB';E={[math]::Round($_.Size/1GB,1)}}, @{N='FreeGB';E={[math]::Round($_.FreeSpace/1GB,1)}}
```
## Disk I/O Performance
```powershell
# Check for disk queue length (values >2 per spindle indicate bottleneck)
$diskCounters = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -ErrorAction SilentlyContinue
if ($diskCounters) {
    $diskCounters | Select-Object Name, @{N='QueueLen';E={$_.CurrentDiskQueueLength}}, @{N='Reads/s';E={$_.DiskReadsPerSec}}, @{N='Writes/s';E={$_.DiskWritesPerSec}}, @{N='AvgReadMs';E={$_.AvgDiskSecPerRead}}, @{N='AvgWriteMs';E={$_.AvgDiskSecPerWrite}}
} else {
    Write-Host 'Disk perf counters unavailable. Run: diskperf -Y && retry after reboot.'
}
# Check for disk errors in event log
Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='disk','storsvc','vhdmp'; Level=1,2,3; StartTime=(Get-Date).AddDays(-7)} -ErrorAction SilentlyContinue | Select-Object TimeCreated, Id, Message
# Check volume health
Get-Volume -ErrorAction SilentlyContinue | Where-Object {$_.HealthStatus -ne 'Healthy'} | Select-Object DriveLetter, FileSystemType, HealthStatus, SizeRemaining
```
## Boot and Errors
```powershell
Write-Host "Last boot: $((Get-CimInstance Win32_OperatingSystem).LastBootUpTime)"
# Boot performance (last 10 boots)
Get-WinEvent -FilterHashtable @{LogName='System'; Id=12,13,6005,6006,6008,6009} -ErrorAction SilentlyContinue | Select-Object -First 20 TimeCreated, Id, Message
# Measure boot time from last boot
$os = Get-CimInstance Win32_OperatingSystem
$boot = $os.LastBootUpTime
# Check for unexpected shutdowns
Get-WinEvent -FilterHashtable @{LogName='System'; Id=41} -MaxEvents 5 -ErrorAction SilentlyContinue | Select-Object TimeCreated, Message
# Application and System errors last 24h
Get-WinEvent -FilterHashtable @{LogName='Application'; Level=2; StartTime=(Get-Date).AddHours(-24)} -ErrorAction SilentlyContinue | Select-Object TimeCreated, ProviderName, Id, Message
Get-WinEvent -FilterHashtable @{LogName='System'; Level=2; StartTime=(Get-Date).AddHours(-24)} -ErrorAction SilentlyContinue | Select-Object TimeCreated, ProviderName, Id, Message
if (Test-Path bin\psloglist64.exe) { bin\psloglist64.exe -accepteula -n 50 -f e }
```
Save to artifacts/scout-reports/performance-profile.md.
