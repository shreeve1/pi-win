---
name: sys-report
description: Consolidated investigation report with remediation plan and approval gate. Output format matches dev-plan so dev-build can execute the plan directly after APPROVE.
---
# Sys Report

Use after investigation completes. Gather all artifacts and synthesize.

## Generate Report

Write to `artifacts\investigations\consolidated-report.md` (UTF-8). Top sections:

1. Executive Summary
2. Problem Statement
3. System Overview
4. Findings (Critical/High/Medium/Low)
5. Root Cause Analysis
6. Unanswered Questions

## Generate Remediation Plan

Also write `artifacts\plans\<kebab-feature-name>.md` (UTF-8) in the **exact format dev-plan produces** so dev-build can execute it. Required sections, in order:

- `# Remediation Plan: <name>`
- `## Problem Summary` (reference investigation artifacts by path)
- `## Root Cause`
- `## Objective`
- `## Relevant Files / Registry / Services` (and `### New Files` if any)
- `## Step by Step Tasks` — every task gets `[N.M]` ID prefix, `[SAFE]`/`[MODERATE]`/`[RISKY]` tag, and `Rollback:` line
- `## Verification` — every check gets `[T.N.M]` ID prefix
- `## Preflight Results`
- `## Acceptance Criteria`
- `## Rollback Plan`
- `## Progress` (build/verify pending, task counts)
- `## Notes`

Task format example:

```md
### 1. Restart Spooler Service
- [ ] [1.1] [SAFE] Restart-Service -Name Spooler -Force
  - Rollback: `Stop-Service -Name Spooler` (service was running before — no rollback needed if it stays up)
- [ ] [1.2] [SAFE] Get-Service -Name Spooler | Select-Object Status, StartType
  - Rollback: (read-only, no rollback)
```

Verification format example:

```md
### T.1. Service Health
- [ ] [T.1.1] Get-Service Spooler | Where-Object Status -eq Running
  - Expected: object returned (service running)
- [ ] [T.1.2] (Get-WinEvent -FilterHashtable @{LogName='System';ID=7034} -MaxEvents 1 -ErrorAction SilentlyContinue).TimeCreated -lt (Get-Date).AddMinutes(-60)
  - Expected: $true (no 7034 in last 60 min) OR no events at all
```

Run the deterministic preflight from `dev-plan` Phase 5 (see `skills\dev-plan\SKILL.md`). Record results under `## Preflight Results`.

## Approval Gate

Present plan summary to technician:

```
Remediation Plan: artifacts\plans\<feature>.md

Risk distribution: <N> SAFE / <N> MODERATE / <N> RISKY
Preflight: <PASS | FAIL N critical / M warning>

Reply:
  APPROVE <feature>   - run /skill:dev-build to execute
  REVISE              - what to change
  ABORT               - discard plan
```

Wait. Do NOT proceed without explicit `APPROVE <feature>` matching the plan filename.

## Why this format

dev-build reads `[N.M]` task IDs and `[T.N.M]` verification IDs to flip checkboxes during execution. Free-form remediation sections cannot be executed automatically. Keep the format strict.
