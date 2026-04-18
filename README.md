# pi-win

A [pi coding agent](https://github.com/mariozechner/pi-coding-agent) harness for running AI-assisted diagnostics and remediation on Windows workstations — silently, in the background, via VSA 9 Live Connect.

## What It Does

pi-win gives IT technicians an automated investigation and remediation platform that runs as `NT AUTHORITY\SYSTEM` on client machines with zero user-facing side effects. No windows, no notifications, no desktop presence.

The agent follows a strict 4-phase workflow:

| Phase | Mode | Description |
|-------|------|-------------|
| 1 — Investigate | Auto | Read-only diagnostics across 10 domains |
| 2 — Plan | Auto | Synthesize findings into a remediation plan |
| 3 — Approval | **Manual gate** | Technician reviews and approves/revises/aborts |
| 4 — Execute | Auto (post-approval) | Applies changes with rollback commands for every step |

## Deployment

Upload the `pi-win` folder to `C:\ita\pi\` on the target machine via Live Connect Files, then run the installer:

```powershell
cd C:\ita\pi\bin; .\install-pi-agent.ps1
```

The installer handles:
- Node.js 22.14.0 LTS (silent MSI)
- `@mariozechner/pi-coding-agent` (global npm)
- Sysinternals toolkit (9 tools, ~3.9 MB)
- Nmap 7.92 portable (~22 MB zip, no installer, no registry)
- Web search extension (requires `SERPER_API_KEY` in `.env`)

Verification output is written to `artifacts/investigations/install-log.md`.

## Skills

| Skill | Description |
|-------|-------------|
| `sys-intake` | Structured problem intake and triage |
| `sys-recon` | Full system baseline (hardware, OS, processes, startup) |
| `sys-network` | Network adapters, DNS, connections, firewall, routing |
| `sys-security` | Persistence mechanisms, suspicious processes, event log analysis |
| `sys-software` | Installed programs, drivers, GPO results, pending updates |
| `sys-performance` | CPU, memory, disk I/O, pagefile, boot time |
| `sys-ad` | Domain membership, DC connectivity, Kerberos, time sync |
| `sys-nmap` | Network scanning (connect scan only — no Npcap) |
| `sys-report` | Consolidated findings + remediation plan with approval gate |
| `sys-cleanup` | Temp file removal, orphan process cleanup, state reset |

## Extensions

- **powershell-bash** — Replaces the default bash tool with PowerShell 5.1 (`-NoProfile -Command`), necessary since the pi agent assumes a Unix shell
- **web-fetch** — Adds `web_search` (Google via Serper API) and `web_fetch` (HTML-to-markdown) for researching error codes and known issues

## Configuration

| File | Purpose |
|------|---------|
| `settings.json` | Shell path, model, theme, extension loader |
| `models.json` | z.ai provider with GLM 4.7 Flash / GLM 5 / GLM 5.1 |
| `auth.json` | Encrypted API key (gitignored) |
| `.env` | `SERPER_API_KEY` for web search (gitignored) |
| `agents/investigator.md` | Custom agent: Windows diagnostics expert, read-only phase 1 |

## Safety Rules

**Read-only (Phase 1)** — the agent may only write to `artifacts/`. No file edits, registry changes, service modifications, installs, or network config changes until Phase 4.

**Privacy** — no access to personal files, user profiles, browser history, saved passwords, or cloud sync folders. Usernames and emails are redacted from all reports.

**Incident response** — if active compromise is detected, the agent stops immediately and reports `[CRITICAL-SECURITY]` without attempting remediation.

**Rollback** — every Phase 4 change includes a rollback command and a `[SAFE]` / `[MODERATE]` / `[RISKY]` tag.

## Artifact Output

```
artifacts/
├── investigations/    # Intake, execution logs, security analysis
├── scout-reports/     # Baseline, network, software, performance, AD, nmap
└── plans/             # Remediation plans (written in Phase 2, executed in Phase 4)
```

## Known Limitations

- Nmap runs connect scan (`-sT`) only — SYN scan (`-sS`) requires Npcap, which is not installed
- `WMIC` is deprecated post-Windows 10 21H1; skills use `Get-CimInstance` instead
- SYSTEM's `HKCU` hive differs from the logged-on user — user-specific registry reads require impersonation or explicit profile loading
- No network drives are mapped under SYSTEM
