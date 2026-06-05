---
name: sys-nmap
description: Network scanning with Nmap 7.92 portable - port discovery, service detection, host discovery, subnet mapping. Read-only. Extracted by install script Step 3b.
---
# Sys Nmap

## Limitations (READ FIRST)

No Npcap driver installed. This means:
- **NO SYN scan (-sS)** -- raw socket operations unavailable
- **Connect scan (-sT) only** -- completes full TCP handshake (logged by target)
- **No ARP scan** -- local network host discovery uses ICMP/TCP instead
- **OS detection (-O)** unreliable without raw packets
- **UDP scan (-sU)** unreliable without Npcap
- **Connect scan is detectable** -- target application logs show connection attempts
- Some scans are slower -- connect scan waits for full handshake per port

What DOES work well:
- Port scanning (TCP connect)
- Service version detection (-sV)
- Script scanning (--script) for many NSE scripts
- Host discovery via ICMP/TCP (-sn)
- Ncat and Nping utilities

## Path
```powershell
# IMPORTANT: Set these variables before running any nmap commands below.
# The install script extracts nmap 7.92 portable zip to bin\nmap\.

# Resolve the current investigation run (see AGENTS.md "Output").
# Scan output goes to $RUN\scans\. $RUN must be set before any -oN path below.
$root = 'artifacts\investigations'
$ptr  = Join-Path $root '.current-run'
if (Test-Path $ptr) { $runId = (Get-Content $ptr -Raw).Trim() }
else {
    $runId = '{0}-adhoc' -f ((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path (Join-Path $root $runId) -Force | Out-Null
    Set-Content -Path $ptr -Value $runId -Encoding UTF8
}
$RUN = Join-Path $root $runId
New-Item -ItemType Directory -Path (Join-Path $RUN 'scans') -Force | Out-Null

$nmap = $null
if (Test-Path "bin\nmap\nmap.exe") { $nmap = "bin\nmap\nmap.exe" }
else { Write-Host 'Nmap not found at bin\nmap\. Run install Step 3b.'; return }
if ($nmap) { Write-Host "Nmap found: $nmap"; & $nmap --version }

$ncat = $nmap -replace 'nmap\.exe$', 'ncat.exe'
$nping = $nmap -replace 'nmap\.exe$', 'nping.exe'
```

## Host Discovery (Ping Sweep)
```powershell
# Discover live hosts on subnet
& $nmap -sn 192.168.1.0/24 -oN "$RUN\scans\nmap-hosts.txt"

# Ping sweep multiple subnets
& $nmap -sn 192.168.1.0/24 192.168.2.0/24 -oN "$RUN\scans\nmap-hosts.txt"

# Skip host discovery (treat all hosts as up) -- faster but less accurate
& $nmap -Pn -sT -F 192.168.1.0/24 -oN "$RUN\scans\nmap-ports.txt"
```

## Port Scanning
```powershell
# Top 100 ports, fast scan
& $nmap -sT -F target -oN "$RUN\scans\nmap-fast.txt"

# Common investigation ports
& $nmap -sT -p 22,23,80,135,139,443,445,1433,3389,5985,5986,8080,8443 target -oN "$RUN\scans\nmap-ports.txt"

# All ports (slow -- use sparingly)
& $nmap -sT -p- target -oN "$RUN\scans\nmap-all-ports.txt"

# Subnet scan -- top ports only
& $nmap -sT -F 192.168.1.0/24 -oN "$RUN\scans\nmap-subnet.txt"
```

## Service Version Detection
```powershell
# Identify what's running on open ports
& $nmap -sT -sV -p 80,443,3389,445,135 target -oN "$RUN\scans\nmap-services.txt"

# Aggressive version detection (more accurate, slower)
& $nmap -sT -sV --version-intensity 5 target -oN "$RUN\scans\nmap-services.txt"
```

## Script Scanning (NSE)
```powershell
# SMB discovery
& $nmap -sT -p 445 --script=smb-protocols,smb-enum-shares target -oN "$RUN\scans\nmap-smb.txt"

# SSL/TLS certificate and cipher check
& $nmap -sT -p 443 --script=ssl-cert,ssl-enum-ciphers target -oN "$RUN\scans\nmap-ssl.txt"

# HTTP headers and title
& $nmap -sT -p 80,443,8080 --script=http-headers,http-title target -oN "$RUN\scans\nmap-http.txt"

# RDP enumeration
& $nmap -sT -p 3389 --script=rdp-enum-encryption,rdp-ntlm-info target -oN "$RUN\scans\nmap-rdp.txt"

# DNS enumeration (if target is DNS server)
& $nmap -sT -p 53 --script=dns-nsid target -oN "$RUN\scans\nmap-dns.txt"

# Vulnerability-like checks (safe scripts only)
& $nmap -sT --script=default,vuln target -oN "$RUN\scans\nmap-vuln.txt"
```

## Ncat (Netcat Replacement)
```powershell
# Test if port is open
& $ncat -zv target 443

# Test multiple ports
22,80,135,443,445,3389 | ForEach-Object { & $ncat -zv -w 2 target $_ 2>&1 }

# Banner grab
& $ncat -v target 80 -w 3

# Listen on port (for testing firewall inbound)
# CAUTION: Only use during approved Phase 4 remediation
# & $ncat -l -p 9999
```

## Nping (Packet Probe)
```powershell
# TCP probe to specific port
& $nping --tcp -p 443 target

# TCP probe with flags
& $nping --tcp -p 80 --flags SYN,ACK target

# ICMP echo (like ping but with more detail)
& $nping --icmp -c 4 target

# ARP ping (local only -- may not work without Npcap)
& $nping --arp -c 1 target
```

## Timing and Performance
```powershell
# T1 -- sneaky, very slow (IDS evasion)
& $nmap -sT -T1 target -oN "$RUN\scans\nmap-slow.txt"

# T3 -- default timing
& $nmap -sT -T3 target

# T4 -- aggressive, faster (use on trusted networks)
& $nmap -sT -T4 -F target -oN "$RUN\scans\nmap-fast.txt"

# T5 -- insane, very fast (may miss ports, use on LAN only)
& $nmap -sT -T5 -F 192.168.1.0/24 -oN "$RUN\scans\nmap-t5.txt"

# Parallel hosts, top 100 ports -- good balance for subnet scan
& $nmap -sT -T4 -F --min-hostgroup 32 192.168.1.0/24 -oN "$RUN\scans\nmap-subnet.txt"
```

## Output Formats
```powershell
# Normal (human readable)
-oN "$RUN\scans\nmap-scan.txt"

# Grepable (parseable)
-oG "$RUN\scans\nmap-scan.gnmap"

# XML (for tools)
-oX "$RUN\scans\nmap-scan.xml"

# All formats at once
-oA "$RUN\scans\nmap-scan"
```

## Investigation Workflows

### Unknown Network Discovery
```powershell
# 1. Find local subnet from adapter config
$ip = (Get-CimInstance Win32_NetworkAdapterConfiguration | Where-Object {$_.IPEnabled}).IPAddress | Where-Object {$_ -match '\.'}
$mask = (Get-CimInstance Win32_NetworkAdapterConfiguration | Where-Object {$_.IPEnabled}).IPSubnet | Where-Object {$_ -match '\.'}
Write-Host "Local IP: $ip Subnet: $mask"

# 2. Ping sweep to find live hosts
& $nmap -sn -T4 192.168.1.0/24 -oN "$RUN\scans\nmap-hosts.txt"

# 3. Quick port scan of discovered hosts
& $nmap -sT -T4 -F -iL "$RUN\scans\nmap-hosts.txt" -oN "$RUN\scans\nmap-quick.txt"

# 4. Deep scan of interesting hosts
& $nmap -sT -sV -T4 -p 22,80,135,139,443,445,1433,3389,5985,8080 <target> -oN "$RUN\scans\nmap-deep.txt"
```

### Suspicious Connection Investigation
```powershell
# 1. Get suspicious remote IPs from established connections
netstat -ano | Select-String "ESTABLISHED" | ForEach-Object {
    $parts = $_.ToString().Trim() -split '\s+'
    $remote = $parts[2]
    $pid = $parts[-1]
    "$remote PID=$pid"
}

# 2. Scan each suspicious IP
& $nmap -sT -sV -T4 <suspicious-ip> -oN "$RUN\scans\nmap-suspicious.txt"

# 3. Check what process owns the connection
Get-Process -Id <pid> | Select-Object Name, Path, Company
```

### Firewall Verification
```powershell
# Verify specific ports are reachable from this machine
& $nmap -sT -Pn -p 80,443,3389,445 target -oN "$RUN\scans\nmap-firewall-check.txt"

# Compare: scan from inside vs outside perspective
& $nmap -sT -Pn -p 22,80,135,139,443,445,3389 localhost -oN "$RUN\scans\nmap-localhost.txt"
```

## Safety Notes
- Connect scan (-sT) completes full TCP handshake -- target application may log the connection
- On production networks, prefer -T2 or -T3 timing to avoid triggering IDS alerts
- Always save output to `$RUN\scans\` with descriptive filenames (`nmap-<target>-<kind>.txt`)
- Never scan external/public IPs without explicit approval (Phase 3)
- Subnet scans generate significant traffic -- use -F (top 100 ports) and -T4 for speed
