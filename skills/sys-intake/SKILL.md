---
name: sys-intake
description: Structured problem intake. First interaction for any investigation.
---
# Sys Intake
Capture technician problem description. Gather: Symptoms, Scope, Onset, Reproduction, Blast radius, Prior actions, Urgency.
Triage to: Network, Security, Performance, Software, AD/Domain, or General.
Check prerequisites:
```powershell
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Host "Elevated: $isAdmin"
Write-Host "PS: $($PSVersionTable.PSVersion)"
$tools = @('pslist64.exe','PsService64.exe','PsInfo64.exe','autorunsc64.exe','tcpvcon64.exe','handle64.exe','sigcheck64.exe','psloglist64.exe','Listdlls64.exe')
foreach ($t in $tools) { if (Test-Path "bin\$t") { Write-Host "Found: $t" } else { Write-Host "Missing: $t" } }
if (Test-Path 'bin\nmap\nmap.exe') { Write-Host 'Found: nmap' } else { Write-Host 'Missing: nmap' }
```
Save to artifacts/investigations/intake.md. Transition to relevant domain skill.
