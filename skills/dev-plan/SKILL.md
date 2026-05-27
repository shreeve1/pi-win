---
name: dev-plan
description: Build a structured remediation plan from investigation findings on a Windows workstation. Single-pass (no audit loop, no Codex). Outputs a plan in the format that dev-build expects, with [SAFE]/[MODERATE]/[RISKY] tags and rollback per step. Use after sys-* investigation skills have gathered evidence and you need a formal Phase 2 plan that goes through the APPROVE gate.
---

# Dev Plan

Synthesize investigation artifacts into a remediation plan. This is the pi-win Phase 2 step. Output feeds directly into Phase 3 (technician APPROVE/REVISE/ABORT) and then dev-build for Phase 4 execution.

This skill is single-pass. The original development-pipeline `Plan` skill runs an iterative Claude <-> Codex audit loop; that depends on the Codex CLI which is not deployed on client workstations. The audit step has been replaced by deterministic preflight checks in Phase 5 below.

## Flags removed from source skill

The source `Plan` skill supports `--rounds N`, `--no-loop`, and `--resume`. All three are removed here because the audit loop is removed. If a technician passes one of those flags out of habit, ignore it silently and proceed single-pass. Do NOT error — just log a note like `flag --rounds ignored (audit loop not available in pi-win)` to the plan's `## Notes` section.

## Pipeline Position

```
sys-intake -> sys-* domain skills -> dev-plan -> [APPROVE] -> dev-build
```

Comes after any investigation. Comes before dev-build.

## Variables

- `USER_PROMPT` - the technician's framing of the remediation goal
- `PLAN_DIR` - `artifacts\plans\` (the standard pi-win output location)
- `SOURCE_DIRS` - search in this order: `artifacts\investigations\`, `artifacts\scout-reports\`, `artifacts\plans\`

## Pre-flight

```powershell
if (-not (Test-Path 'artifacts\plans')) {
    New-Item -ItemType Directory -Path 'artifacts\plans' -Force | Out-Null
}
```

## Workflow

### Phase 1 - Parse the goal

From USER_PROMPT identify:
- Target subsystem (network, security, software, AD, performance, etc.)
- Task type (fix | mitigate | clean-up | configure | restore)
- Complexity (single-step | medium | multi-step)
- Constraints (do not reboot, do not log user off, no service restart during business hours, etc.)

### Phase 2 - Source discovery

If USER_PROMPT is a file path, read it directly.

Otherwise, enumerate `.md` files in SOURCE_DIRS sorted by `LastWriteTime` descending:

```powershell
Get-ChildItem -Path 'artifacts\investigations','artifacts\scout-reports','artifacts\plans' `
    -Filter '*.md' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 10 FullName, LastWriteTime
```

Ask the technician to confirm which artifacts are the source of truth for this plan. If they decline to pick, default to the most recent file per directory.

### Phase 3 - Vague prompt check

If USER_PROMPT is under ~20 words AND Phase 2 found no source artifacts, ask 2-3 clarifying questions:
- Scope (which user, which machine, which service)
- Constraints (downtime tolerance, change window, rollback expectations)
- Success criteria (what does "fixed" look like)

If USER_PROMPT is substantive OR Phase 2 attached source artifacts, skip.

### Phase 4 - Draft the plan

Write to `artifacts\plans\<kebab-feature-name>.md` using the Plan Format below. Use UTF-8 encoding (`Out-File -Encoding UTF8`).

### Phase 5 - Deterministic preflight

Before declaring the plan ready, run these checks on the target machine. Each failure becomes a `[CRITICAL]` or `[WARNING]` note appended to the plan's Validation section.

| Check | PowerShell | Severity if fails |
|---|---|---|
| Edit-target paths exist | `Test-Path '<path>'` for every file the plan modifies | CRITICAL |
| Registry keys exist | `Test-Path 'HKLM:\<key>'` for every key the plan reads or writes | CRITICAL |
| Tools available | `Get-Command <tool> -ErrorAction SilentlyContinue` for every external binary | CRITICAL |
| Services exist | `Get-Service <name> -ErrorAction SilentlyContinue` for every service touched | CRITICAL |
| Sysinternals tools present | `Test-Path "bin\<tool>64.exe"` for any sysint tool referenced | WARNING (note fallback) |
| Elevation needed | Compare elevation requirement vs current state from sys-intake | CRITICAL if mismatched |
| Pending reboot | `Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'` | WARNING |
| Disk space for rollback | `(Get-Volume -DriveLetter C).SizeRemaining` >= rollback footprint | WARNING |

Record results in the plan's `## Preflight Results` section.

### Phase 6 - Present for approval

Output the plan path and a summary block:

```
Remediation Plan Created

  File: artifacts\plans\<feature>.md
  Topic: <one-line summary>

  Risk distribution:
  - SAFE: <count>
  - MODERATE: <count>
  - RISKY: <count>

  Preflight: <PASS | FAIL with N critical / M warning>

  Awaiting Phase 3 approval. Reply:
    APPROVE  - run dev-build to execute
    REVISE   - what to change
    ABORT    - discard plan
```

Then STOP. Do not execute. Do not invoke dev-build. Wait for the technician.

## Plan Format

Write to `artifacts\plans\<feature>.md`. Format is fixed - dev-build depends on the `[N.M]` task IDs and `[T.N.M]` verification IDs.

```md
# Remediation Plan: <task name>

## Problem Summary
<1-3 sentences. Reference investigation artifact(s) by path.>

## Root Cause
<evidence-backed statement, or "inconclusive — proceeding with mitigation only">

## Objective
<what success looks like in one sentence>

## Relevant Files / Registry / Services
- `<path or key>` — <why>

### New Files (if any)
- `<path>` — <purpose, e.g. backup of original>

## Step by Step Tasks
IMPORTANT: dev-build executes these sequentially in order. Annotate each task with [SAFE]/[MODERATE]/[RISKY].

### 1. <First Task Name>
- [ ] [1.1] [SAFE] <specific PowerShell command>
  - Rollback: `<powershell command>`
- [ ] [1.2] [MODERATE] <specific PowerShell command>
  - Rollback: `<powershell command>`

### 2. <Second Task Name>
- [ ] [2.1] [RISKY] <specific PowerShell command>
  - Rollback: `<powershell command>`

## Verification
<derive verification tasks from the bug's reproduction case. Each uses [T.N.M] ID prefix.>

### T.1. <Verification Category>
- [ ] [T.1.1] <specific check command, expected output>
- [ ] [T.1.2] <specific check command, expected output>

## Preflight Results
<populated by Phase 5. One line per check.>

- [PASS] Edit-target C:\Windows\System32\drivers\... exists
- [FAIL CRITICAL] Service `SomeService` not found on this machine
- [WARN] Pending reboot detected — may need to retry after restart

## Acceptance Criteria
<specific, measurable criteria. Examples:>
- Service `Spooler` reports `Status: Running` and `StartType: Automatic`
- Event 7034 for `Spooler` does not recur within 60 minutes
- No new errors in System log Level <= 2 in the next hour

## Rollback Plan
If any step fails OR acceptance criteria are not met after execution:

1. Stop further steps immediately.
2. Run rollback commands in REVERSE order of execution.
3. Append failure details to `artifacts\investigations\execution-log.md`.
4. Hand off to /skill:handoff for escalation.

## Progress
**Phase Status:**
- Build: `pending`
- Verify: `pending`

**Task Counts:**
- Implementation: `0/<N>` tasks complete
- Verification: `0/<M>` checks passed

**Last Updated:** `---`

## Notes
<optional: prior remediation attempts, related KBs, vendor advisories, change-window constraints>
```

## Constraints

- Phase 1-5 are READ-ONLY. Per pi-win 4-phase workflow.
- Every task MUST have a rollback command, or be tagged `[SAFE]` and trivially reversible (e.g. read-only).
- Every `[RISKY]` task MUST have explicit technician acknowledgement language in the APPROVE prompt.
- Never propose disabling AV / EDR / firewall without time-limited re-enable plan.
- Never propose changes that touch user profile / personal data per project CLAUDE.md privacy rules.
- If the only viable plan involves destructive or irreversible actions (format, registry hive replacement, account deletion): flag at the top of the plan, do NOT include in Step by Step Tasks — escalate via /skill:handoff.

## Instructions

- If USER_PROMPT is missing, ask the technician to provide it.
- Generate descriptive kebab-case filename from the plan's main topic (e.g. `spooler-crash-loop-fix.md`).
- Match the Plan Format exactly — dev-build's checkbox flipping depends on `[N.M]` and `[T.N.M]` IDs.
- Do NOT execute. Do NOT invoke dev-build. STOP at Phase 6.
