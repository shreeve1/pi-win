# Tools

## Sysinternals CLI Toolkit
Run download-tools.ps1 to fetch tools (~3.9 MB).
Tools: pslist64, psservice64, psinfo64, autorunsc64, tcpvcon64, handle64, sigcheck64, psloglist64, Listdlls64
Always use -accepteula flag.

## Nmap 7.92 (Portable)
Downloaded and extracted by install-pi-agent.ps1 to bin\nmap\ (~22 MB zip).
Binaries: nmap.exe, ncat.exe, nping.exe
No Npcap driver -- connect scan (-sT) only. SYN scan (-sS) unavailable.
Portable zip -- no installer, no registry entries, easy cleanup.
