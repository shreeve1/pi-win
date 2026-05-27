---
name: handoff
description: Compact the current pi-win session into a handoff document for another agent or technician to pick up. Use when an investigation is interrupted, a shift changes, or a remediation plan is approved but execution will happen later.
---

# Handoff

Write a handoff document summarising the current session so a fresh pi agent (or a human technician) can continue the work without re-running diagnostics. Save the doc and output a copy-paste prompt for the next session.

## When to use

- Investigation completed Phase 1 but technician will return later to review the plan
- Phase 2 plan written but Phase 3 approval is deferred
- Phase 4 execution paused mid-run
- Shift handover, escalation to a senior tech, or transfer to a different RMM session

## Output location

Generate a deterministic filename in `artifacts/investigations/`:

```powershell
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$hostname = $env:COMPUTERNAME
$path = "artifacts\investigations\handoff-$hostname-$timestamp.md"
```

If `artifacts\investigations\` does not exist, create it:

```powershell
if (-not (Test-Path 'artifacts\investigations')) {
    New-Item -ItemType Directory -Path 'artifacts\investigations' -Force | Out-Null
}
```

Read the path before writing to confirm it doesn't already exist.

## Discover session artifacts

Before writing the handoff, enumerate everything in `artifacts\` ordered by most-recently-modified. This is the source list for the "What Has Been Done" section:

```powershell
Get-ChildItem -Path 'artifacts' -Recurse -Filter '*.md' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object FullName, LastWriteTime, @{N='SizeKB';E={[math]::Round($_.Length/1KB,1)}} |
    Format-Table -AutoSize
```

Also list non-markdown artifacts (CSV exports, evtx, logs):

```powershell
Get-ChildItem -Path 'artifacts' -Recurse -Exclude '*.md' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object FullName, LastWriteTime, @{N='SizeKB';E={[math]::Round($_.Length/1KB,1)}}
```

For each artifact, write ONE bullet referencing it by path. Do NOT inline file contents.

## Document structure

Write the file as UTF-8 (`Out-File -Encoding UTF8`) with this layout:

```md
# Handoff: <one-line summary of the problem>

**Host:** <COMPUTERNAME>
**Session started:** <ISO timestamp from $env:PI_SESSION_START or earliest artifact mtime>
**Handoff written:** <ISO timestamp now>
**Phase reached:** 1 / 2 / 3 / 4
**Elevated:** <true|false>

## Problem Statement
<1-3 sentence restatement of the technician's reported problem>

## What Has Been Done
- <bulleted summary of investigation steps>
- Reference existing artifacts by path, do NOT duplicate content:
  - `artifacts/investigations/intake.md`
  - `artifacts/scout-reports/<file>.md`
  - `artifacts/plans/remediation-plan.md`

## Current State
- Open questions
- Hypotheses still unconfirmed
- Tools/commands that failed (with exit codes) and need a different approach

## Next Steps
- Concrete actions for the next session
- Which skill to invoke next (e.g. `/skill:sys-security`, `/skill:sys-report`)
- Awaiting approval? Note the exact APPROVE/REVISE/ABORT prompt that was presented

## Suggested Skills for Next Session
- `<skill-name>` — <why>
```

## Rules

- Do NOT copy artifact contents into the handoff. Reference paths only.
- Do NOT include personal data, usernames, or file contents from user profiles. Per project CLAUDE.md privacy rules.
- Redact any user-identifying strings encountered during the session.
- Keep the document under ~150 lines. If you exceed that, you're duplicating artifact content.

## Copy-paste prompt

After writing the file, output to the technician (do NOT write to disk) a block like:

```
Handoff written: <path>

To resume in a new pi session:
  Set-Location 'C:\ProgramData\pi-win'
  pi
  > Read artifacts\investigations\handoff-<host>-<timestamp>.md and continue from "Next Steps". Apply the 4-phase workflow from AGENTS.md.
```

## Arguments

If the user passed arguments after `/skill:handoff`, treat them as a description of what the next session should focus on. Tailor the "Next Steps" section accordingly.
