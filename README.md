# pi-win

A [pi coding agent](https://github.com/earendil-works/pi-coding-agent) harness for running AI-assisted diagnostics and remediation on Windows workstations — silently, in the background, via any RMM tool.

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

Run this one-liner from your RMM's inline script runner — no file upload needed:

```powershell
irm https://raw.githubusercontent.com/shreeve1/pi-win/main/bin/install-pi-agent.ps1 | iex
```

To inject keys at deploy time:

```powershell
$s = irm https://raw.githubusercontent.com/shreeve1/pi-win/main/bin/install-pi-agent.ps1
& ([scriptblock]::Create($s)) -ModelProvider "zai" -ModelApiKey "your-model-key" -SerperApiKey "your-serper-key"
```

Same model-key install as a single line:

```powershell
$s = irm https://raw.githubusercontent.com/shreeve1/pi-win/main/bin/install-pi-agent.ps1; & ([scriptblock]::Create($s)) -ModelProvider "zai" -ModelApiKey "your-model-key"
```

To rotate only the Zai API key without forcing a repo reinstall:

```powershell
$s = irm https://raw.githubusercontent.com/shreeve1/pi-win/main/bin/install-pi-agent.ps1; & ([scriptblock]::Create($s)) -ModelProvider "zai" -ModelApiKey "your-new-model-key" -ForceAuth
```

Or keep keys in a local `.env` file that is never committed:

```powershell
@'
MODEL_PROVIDER=zai
MODEL_API_KEY=your-model-key
SERPER_API_KEY=your-serper-key
'@ | Out-File -FilePath "C:\ProgramData\pi-win.env" -Encoding UTF8

$s = irm https://raw.githubusercontent.com/shreeve1/pi-win/main/bin/install-pi-agent.ps1
& ([scriptblock]::Create($s)) -EnvFile "C:\ProgramData\pi-win.env"
```

For fresh installs, keep the source `.env` outside `C:\ProgramData\pi-win` until after the installer downloads the repo. Remove that source file after install if you do not want a plaintext key copy outside `auth.json`.

Or if you prefer to deploy the folder manually first:

```powershell
cd C:\ProgramData\pi-win\bin; .\install-pi-agent.ps1
```

To update an existing install (preserves `artifacts/` and `.env`, skips Node/npm):

```powershell
C:\ProgramData\pi-win\bin\update-pi.ps1
```

To force a full reinstall from GitHub when running the bootstrap again:

```powershell
$s = irm https://raw.githubusercontent.com/shreeve1/pi-win/main/bin/install-pi-agent.ps1; & ([scriptblock]::Create($s)) -Force
```

To force reinstall and set the Zai API key in one line:

```powershell
$s = irm https://raw.githubusercontent.com/shreeve1/pi-win/main/bin/install-pi-agent.ps1; & ([scriptblock]::Create($s)) -Force -ModelProvider "zai" -ModelApiKey "your-model-key"
```

Use `-Force` when you need installed repo files refreshed, not just missing pieces filled in.
Use `-ForceAuth` when you only need to overwrite the stored model API key.

The installer handles:
- Node.js 22.14.0 LTS (silent MSI)
- `@earendil-works/pi-coding-agent` (global npm)
- Sysinternals toolkit (9 tools, ~3.9 MB)
- Nmap 7.92 portable (~22 MB zip, no installer, no registry)
- Local `.env` loading for `MODEL_PROVIDER`, `MODEL_API_KEY`, provider-specific keys like `ZAI_API_KEY`, and `SERPER_API_KEY`
- Web search extension (requires `SERPER_API_KEY` in `.env` or deploy-time key injection)

Verification output is written to `artifacts/investigations/install-log.md`.

## Dual-Access Deploy

RMM jobs running as `NT AUTHORITY\SYSTEM` and admins in an elevated RDP PowerShell session use the same install at `C:\ProgramData\pi-win`.

For RMM tools that allow profiles, invoke Pi from any directory:

```powershell
powershell.exe -ExecutionPolicy Bypass -Command "pi"
```

If an RMM tool forces `-NoProfile`, the profile wrapper cannot load. Use an explicit install-dir hop instead:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Set-Location 'C:\ProgramData\pi-win'; pi"
```

For admin access, RDP to the workstation, open an elevated PowerShell session, then run:

```powershell
pi
```

The installer sets `PI_CODING_AGENT_DIR` machine-wide to `C:\ProgramData\pi-win`, so SYSTEM and elevated admin sessions share the same `auth.json`, skills, extensions, and artifacts. It also writes `C:\ProgramData\pi-win\AGENTS.md` from the repo's `CLAUDE.md`; this install-only file is not kept in the project repo. The AllUsersAllHosts PowerShell profile wrapper in `$PsHome\Profile.ps1` temporarily changes into the install directory before calling `pi.cmd`, which lets `AGENTS.md` load even when `pi` is started from another directory.

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
| `models.json` | AI provider and model definitions (swap to any compatible provider) |

To use a different AI provider, add an entry to `models.json` and update `settings.json`:

```json
// models.json — add alongside the existing provider
"openai": {
  "baseUrl": "https://api.openai.com/v1",
  "api": "openai-chat",
  "apiKey": "OPENAI_API_KEY",
  "models": [{ "id": "gpt-4o", "name": "GPT-4o", ... }]
}
```

```json
// settings.json — point to the new provider and model
"defaultProvider": "openai",
"defaultModel": "gpt-4o"
```

Then deploy with `-ModelProvider openai -ModelApiKey "your-key"`, or set `MODEL_PROVIDER=openai` and `MODEL_API_KEY=your-key` in a local `.env` passed with `-EnvFile`, so `auth.json` is written correctly.
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
