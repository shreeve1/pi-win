---
name: sys-network
description: Network diagnostics - adapters, DNS, connectivity, connections, firewall. Read-only.
---
# Sys Network
## Adapters
```powershell
Get-CimInstance Win32_NetworkAdapterConfiguration | Where-Object {$_.IPEnabled} | Select-Object Description, IPAddress, DefaultIPGateway, DNSServerSearchOrder, DHCPServer, MACAddress
```
## DNS and Connectivity
```powershell
ipconfig /displaydns
nslookup google.com
$gw = (Get-CimInstance Win32_NetworkAdapterConfiguration | Where-Object {$_.IPEnabled}).DefaultIPGateway
foreach ($g in $gw) { if (Test-Connection $g -Count 2 -Quiet) { Write-Host "GW $g : OK" } else { Write-Host "GW $g : FAIL" } }
try { Invoke-WebRequest -Uri "https://www.google.com" -TimeoutSec 10 -UseBasicParsing | Out-Null; Write-Host "Internet: OK" } catch { Write-Host "Internet: FAIL" }
```
## Connections
```powershell
if (Test-Path bin\tcpvcon64.exe) { bin\tcpvcon64.exe -accepteula -a -c -n } else { netstat -ano }
netstat -ano | Select-String "ESTABLISHED"
```
## Firewall
```powershell
route print
netsh advfirewall show allprofiles
netsh advfirewall firewall show rule name=all dir=in status=enabled
netsh winhttp show proxy
```
## Deep Network Scanning
For port scanning, service detection, and host discovery, invoke the **sys-nmap** skill.
Save to artifacts/scout-reports/network-diagnostics.md.
