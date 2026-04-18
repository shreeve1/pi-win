---
name: sys-ad
description: AD diagnostics - domain join, DC, Kerberos, GPO, trust. Handles non-domain gracefully.
---
# Sys AD
## Domain Check
```powershell
$cs = Get-CimInstance Win32_ComputerSystem
if ($cs.PartOfDomain) { Write-Host "Domain: $($cs.Domain) Role: $($cs.DomainRole)" }
else { Write-Host "NOT domain-joined. Workgroup: $($cs.Workgroup). AD checks skipped." }
```
## DC Connectivity
```powershell
nltest /dsgetdc:$env:USERDNSDOMAIN 2>&1
try { $ldap = [ADSI]"LDAP://$env:USERDNSDOMAIN"; $ldap.Name | Out-Null; Write-Host "LDAP: OK" } catch { Write-Host "LDAP: FAIL" }
```
## Kerberos and Time
```powershell
klist
w32tm /query /status
```
## Trust
```powershell
nltest /sc_query:$env:USERDNSDOMAIN 2>&1
Test-ComputerSecureChannel -Verbose -ErrorAction SilentlyContinue
```
## Account
```powershell
whoami /all
```
Save to artifacts/scout-reports/ad-diagnostics.md.
