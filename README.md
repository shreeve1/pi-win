# pi-win

A [pi coding agent](https://github.com/earendil-works/pi-coding-agent) harness for running AI-assisted diagnostics and remediation on Windows workstations — silently, in the background, via any RMM tool.

## What It Does

pi-win gives IT technicians an automated investigation and remediation platform that runs as `NT AUTHORITY\SYSTEM` on client machines with zero user-facing side effects. No windows, no notifications, no desktop presence.

Every AI session is audit-logged by default under `C:\ProgramData\pi-win\artifacts\sessions\<UTC timestamp>\`. The human-readable `audit-actions.md` report includes a chronological action ledger showing what the AI read, wrote, edited, ran, or attempted; `audit-actions.jsonl` stores the same ledger in machine-readable form.

The agent follows a strict 4-phase workflow:

| Phase | Mode | Description |
|-------|------|-------------|
| 1 — Investigate | Auto | Read-only diagnostics across 10 domains |
| 2 — Plan | Auto | Synthesize findings into a remediation plan |
| 3 — Approval | **Manual gate** | Technician reviews and approves/revises/aborts |
| 4 — Execute | Auto (post-approval) | Applies changes with rollback commands for every step |

## Contents

- [Deployment](#deployment)
- [Dual-Access Deploy](#dual-access-deploy)
- [Maintaining the Package (operators)](#maintaining-the-package-operators)
- [Reference Docs](#reference-docs)
- [Skills](#skills)
- [Extensions](#extensions)
- [AI Session Audit Logs](#ai-session-audit-logs)
- [Configuration](#configuration)
- [Safety Rules](#safety-rules)
- [Artifact Output](#artifact-output)
- [Known Limitations](#known-limitations)

## Deployment

Run the installer from your RMM inline script runner. No file upload required.

```powershell
irm https://raw.githubusercontent.com/shreeve1/pi-win/main/bin/install-pi-agent.ps1 | iex
```

For a model-backed install, pass the provider, optional model ID, and API key:

```powershell
$s = irm https://raw.githubusercontent.com/shreeve1/pi-win/main/bin/install-pi-agent.ps1
& ([scriptblock]::Create($s)) -ModelProvider "zai" -ModelId "glm-5.1" -ModelApiKey "your-model-key" -SerperApiKey "your-serper-key"
```

`-ModelProvider` selects a provider from `models.json`. `-ModelId` selects one model from that provider. If `-ModelId` is omitted, the installer uses the first model listed for the provider and syncs `settings.json` (`defaultProvider` / `defaultModel`) so Pi starts on that model. `-ModelApiKey` is written to `auth.json`.

### Supported providers and models

| Provider | Models | Provider-specific key |
|----------|--------|-----------------------|
| `zai` | `glm-4.7-flash`, `glm-5`, `glm-5.1` | `ZAI_API_KEY` |
| `deepseek` | `deepseek-v4-pro`, `deepseek-v4-flash` | `DEEPSEEK_API_KEY` |

Model definitions live in `models.json`. Add new OpenAI-compatible or Anthropic-compatible providers there, then deploy with the matching `-ModelProvider`, `-ModelId`, and key.

For repeatable RMM jobs, keep keys in a local `.env` file that is never committed:

```powershell
@'
MODEL_PROVIDER=deepseek
MODEL_ID=deepseek-v4-flash
MODEL_API_KEY=your-model-key
SERPER_API_KEY=your-serper-key
'@ | Out-File -FilePath "C:\ProgramData\pi-win.env" -Encoding UTF8

$s = irm https://raw.githubusercontent.com/shreeve1/pi-win/main/bin/install-pi-agent.ps1
& ([scriptblock]::Create($s)) -EnvFile "C:\ProgramData\pi-win.env"
```

The installer also accepts provider-specific keys in `.env`. For example, `DEEPSEEK_API_KEY=...` is used when `MODEL_PROVIDER=deepseek` and `MODEL_API_KEY` is not set.

For fresh installs, keep the source `.env` outside `C:\ProgramData\pi-win` until after the installer downloads the repo. Remove that source file after install if you do not want a plaintext key copy outside `auth.json`.

Common maintenance commands:

```powershell
# Rotate only the stored model API key.
$s = irm https://raw.githubusercontent.com/shreeve1/pi-win/main/bin/install-pi-agent.ps1; & ([scriptblock]::Create($s)) -ModelProvider "deepseek" -ModelApiKey "your-new-model-key" -ForceAuth

# Refresh installed repo files from GitHub.
$s = irm https://raw.githubusercontent.com/shreeve1/pi-win/main/bin/install-pi-agent.ps1; & ([scriptblock]::Create($s)) -Force

# Force reinstall and set provider/model/key in one pass.
$s = irm https://raw.githubusercontent.com/shreeve1/pi-win/main/bin/install-pi-agent.ps1; & ([scriptblock]::Create($s)) -Force -ModelProvider "zai" -ModelId "glm-5.1" -ModelApiKey "your-model-key"

# Update an existing install; preserves artifacts, .env, settings.json, and auth.json.
C:\ProgramData\pi-win\bin\update-pi.ps1
```

Use `-Force` when installed repo files need to be refreshed. Use `-ForceAuth` when only the stored model API key should be overwritten.

If you deploy the folder manually first, run the installer from the local copy:

```powershell
cd C:\ProgramData\pi-win\bin; .\install-pi-agent.ps1
```

After the first deploy, smoke-test from the client:

```powershell
cd C:\ProgramData\pi-win; pi
# Inside pi: /model  -> confirm the selected provider/model
# Run a small prompt to confirm reasoning + tool-use round trip
```

The installer handles:
- Node.js 22.19.0 or newer (silent MSI)
- `@earendil-works/pi-coding-agent` (global npm)
- Sysinternals toolkit (9 tools, ~3.9 MB)
- Nmap 7.92 portable (~22 MB zip, no installer, no registry)
- Local `.env` loading for model provider/model/key and `SERPER_API_KEY`
- Provider-specific API keys like `ZAI_API_KEY` and `DEEPSEEK_API_KEY`
- Automatic `settings.json` sync for `defaultProvider` and `defaultModel`
- Web search extension when `SERPER_API_KEY` is present

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

The installer sets `PI_CODING_AGENT_DIR` machine-wide to `C:\ProgramData\pi-win`, so SYSTEM and elevated admin sessions share the same `auth.json`, skills, extensions, and artifacts. Pi loads its operating instructions from `AGENTS.md`; in the repo `AGENTS.md` is a symlink to `CLAUDE.md` (single source of truth, so Pi-from-repo and Claude Code share identical instructions), and the installer also materializes a real `C:\ProgramData\pi-win\AGENTS.md` copy on the client. The AllUsersAllHosts PowerShell profile wrapper in `$PsHome\Profile.ps1` temporarily changes into the install directory before calling `pi.cmd`, which lets `AGENTS.md` load even when `pi` is started from another directory.

## Maintaining the Package (operators)

This is an operator/maintainer task — the on-client agent never does it.

The pi-win package and install script are distributed from your RMM server's
managed-files / shared-applications share. Site-specific values (RMM server
host/IP, package share path, infra repo, admin account) are environment-specific
— keep them in an untracked `DEPLOYMENT.local.md` (gitignored), not in tracked
files. Placeholders:

- Package + installer path on the RMM server: `<RMM_PACKAGE_PATH>`
- RMM server: `<RMM_SERVER_HOST>` at `<RMM_SERVER_IP>`; access via `ssh <RMM_ADMIN_USER>@<RMM_SERVER_IP>`
- Infrastructure repo (for RMM-server access/docs): `<INFRA_REPO_PATH>`
- Before updating package files on the RMM server, inspect current contents and make a backup/rollback copy.

## Reference Docs

- `docs/powershell-reference.md` — PowerShell 5.1 / WMI / Sysinternals / Nmap reference (read on demand; not inlined into the agent prompt)

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
| `sys-report` | Consolidated findings + remediation plan with approval gate (output format aligned with `dev-plan`/`dev-build`) |
| `sys-cleanup` | Temp file removal, orphan process cleanup, state reset |
| `handoff` | Compact current session into a handoff doc so another agent or shift can pick up the work |
| `dev-diagnose` | Disciplined diagnosis loop for hard bugs / perf regressions — reproduce, hypothesise, instrument. Stops at Phase 5 for APPROVE gate |
| `dev-plan` | Build a structured remediation plan with `[SAFE]/[MODERATE]/[RISKY]` tags, rollback per step, PowerShell preflight checks |
| `dev-build` | Execute an APPROVED remediation plan sequentially with logging, plan-hash tamper check, elevation check, full reverse-order rollback on failure |

### Pipeline

```
sys-intake -> sys-* (recon/network/security/software/perf/ad/nmap) -> sys-report OR dev-plan
                                                                              |
                                                                         [APPROVE <plan>]
                                                                              |
                                                                          dev-build
                                                                              |
                                                                         sys-cleanup
```

`dev-diagnose` slots in between `sys-*` skills when one of them can't pin root cause. `handoff` writes a resume doc at any pause point.

## Extensions

- **session-audit-logger** — Writes local JSONL audit logs for pi session lifecycle events, summarized prompts/messages/tool calls, command-result metadata, model changes, and approval text seen by the session
- **powershell-bash** — Replaces the default bash tool with PowerShell 5.1 (`-NoProfile -Command`), necessary since the pi agent assumes a Unix shell
- **web-fetch** — Adds `web_search` (Google via Serper API) and `web_fetch` (HTML-to-markdown) for researching error codes and known issues

## AI Session Audit Logs

`session-audit-logger` is enabled by default in `settings.json`. It writes local-only audit artifacts under `PI_CODING_AGENT_DIR` (normally `C:\ProgramData\pi-win`):

```
artifacts/sessions/<UTC timestamp>/
├── audit-actions.jsonl # append-only machine-readable action ledger
├── audit-actions.md    # human-readable action report
├── audit-summary.md    # session metadata, action counts, event counts
└── audit-events.jsonl  # optional raw event stream; written only when PI_AUDIT_RAW_EVENTS=1
```

Session folder names use UTC timestamps like `20260611-211925-123Z`; Pi's original random session id is retained inside audit records as `piSessionId`. The primary audit output is an action ledger covering file reads, file writes, file edits, delete-risk shell commands, opaque shell commands, network/web access, provider requests/responses, and session lifecycle. By default, prompt text, message content, tool output, command text, and provider request payloads are summarized with lengths and hashes instead of full content. File paths and redacted shell commands are retained so a session can be audited for accessed and changed files. Host/user values are hashed by default.

Path and command retention is a deliberate privacy/audit tradeoff: paths and redacted commands are logged by default because action auditing needs evidence of what was accessed or changed, but those strings can still include usernames, client names, case names, or other sensitive naming context.

Optional high-detail modes are environment-variable gated and should be enabled only when internal audit explicitly accepts the client-data risk:

- `PI_AUDIT_CONTENT_PREVIEW=1` — include short redacted previews in summaries.
- `PI_AUDIT_FULL_CONTENT=1` — include full prompt/message/tool content after best-effort redaction.
- `PI_AUDIT_FULL_PROVIDER_PAYLOAD=1` — include full serialized provider request payload after best-effort redaction.
- `PI_AUDIT_INCLUDE_HOST_USER=1` — include raw host/user values instead of hashes.
- `PI_AUDIT_FILE_HASHES=1` — add existence, byte count, and capped SHA-256 file proof metadata for built-in file tools; file contents are not logged.
- `PI_AUDIT_RAW_EVENTS=1` — write the lower-level `audit-events.jsonl` event stream for debugging.

Logging failures are swallowed so audit write problems do not break the AI session. Redaction is best-effort; full-content modes can still persist sensitive client data and should not be used by default on client systems. PowerShell command classification is heuristic: common file operations such as `Remove-Item`, `Set-Content`, `Copy-Item`, and `Move-Item` are labeled, but arbitrary scripts can still have side effects that are not statically detectable from the command line alone.

## Configuration

| File | Purpose |
|------|---------|
| `settings.json` | Shell path, default provider/model, theme, extension loader, audit logger enablement |
| `models.json` | AI provider and model definitions |
| `auth.json` | Encrypted API keys (gitignored) |
| `.env` | Optional local deploy values such as `MODEL_PROVIDER`, `MODEL_ID`, `MODEL_API_KEY`, provider-specific keys, and `SERPER_API_KEY` (gitignored) |
| `agents/investigator.md` | Custom agent: Windows diagnostics expert, read-only phase 1 |

To add a provider, append an entry to `models.json`. The bundled `zai` and `deepseek` blocks are the working precedents.

```jsonc
// models.json — add alongside existing providers
"openai": {
  "baseUrl": "https://api.openai.com/v1",
  "api": "openai-chat",
  "apiKey": "OPENAI_API_KEY",
  "models": [{ "id": "gpt-4o", "name": "GPT-4o" }]
}
```

Then deploy with `-ModelProvider openai -ModelId "gpt-4o" -ModelApiKey "your-key"`, or set `MODEL_PROVIDER=openai`, `MODEL_ID=gpt-4o`, and `MODEL_API_KEY=your-key` in a local `.env` passed with `-EnvFile`. The installer writes the key to `auth.json` and syncs `settings.json` (`defaultProvider` / `defaultModel`) automatically.

## Safety Rules

**Read-only (Phase 1)** — the agent may only write to `artifacts/`. No file edits, registry changes, service modifications, installs, or network config changes until Phase 4.

**Privacy** — no access to personal files, user profiles, browser history, saved passwords, or cloud sync folders. Usernames and emails are redacted from all reports.

**Incident response** — if active compromise is detected, the agent stops immediately and reports `[CRITICAL-SECURITY]` without attempting remediation.

**Rollback** — every Phase 4 change includes a rollback command and a `[SAFE]` / `[MODERATE]` / `[RISKY]` tag.

## Artifact Output

Output is **run-scoped** — one investigation = one run directory, never
overwritten. See the "Output" section in `CLAUDE.md` / `AGENTS.md` for the full
spec and the run-resolver snippet.

```
artifacts/
├── investigations/
│   └── <run-id>/                  # run-id = <UTC yyyyMMdd-HHmmss>-<slug>
│       ├── manifest.md            # run header + artifact index
│       ├── intake.md              # sys-intake
│       ├── summary.md             # sys-report consolidated findings
│       ├── hosts/<host>/          # recon, network, security, software, performance, ad
│       ├── scans/                 # nmap raw output
│       ├── logs/                  # execution-log.md, diag-*.log
│       └── handoff-<ts>.md
├── sessions/
│   └── <UTC timestamp>/           # AI action ledger, action report, summary, optional raw events
└── plans/
    └── <run-id>-<feature>.md      # remediation plan (APPROVE <run-id>-<feature>)
```

## Known Limitations

- Nmap runs connect scan (`-sT`) only — SYN scan (`-sS`) requires Npcap, which is not installed
- `WMIC` is deprecated post-Windows 10 21H1; skills use `Get-CimInstance` instead
- SYSTEM's `HKCU` hive differs from the logged-on user — user-specific registry reads require impersonation or explicit profile loading
- No network drives are mapped under SYSTEM
