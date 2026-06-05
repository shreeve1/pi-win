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
## Establish the investigation run

sys-intake OWNS the run-id. Derive a kebab-case slug (2-4 words) from the
problem (e.g. `slow-boot`, `dns-resolution-fail`, `unknown-network-survey`),
then start the run via the shared helper (it creates the dirs + `.current-run`
pointer that every other skill reads):

```powershell
. bin\Resolve-Run.ps1 -Slug '<kebab-slug-from-problem>' | Out-Null
# $RUN and $HOSTDIR are now set for the rest of the session.
```

Write `manifest.md` (run header) and `intake.md` into `$RUN`, both with the
standard artifact header (see AGENTS.md "Output"). intake.md captures the
problem, triage category, and prerequisite results. Then transition to the
relevant domain skill.
