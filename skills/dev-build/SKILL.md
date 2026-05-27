---
name: dev-build
description: Execute an APPROVED remediation plan on a Windows workstation, sequentially, one task at a time, with rollback on failure. Reads plans produced by dev-plan (or sys-report). Logs every action to artifacts/investigations/execution-log.md. Use ONLY after the technician has typed APPROVE in pi-win Phase 3.
---

# Dev Build

Execute a remediation plan. This is pi-win Phase 4. Tasks run **sequentially** (no parallel waves) and stop on the first failure. Every executed command and its result is logged.

This skill REQUIRES that the technician has already typed APPROVE for the specific plan being executed. If you cannot confirm approval in the current conversation, refuse to run and ask for explicit APPROVE first.

The original development-pipeline `Build` skill runs wave-based parallel execution with a Codex audit at each wave boundary. Both are removed here:
- No parallelism. Client workstation remediation is high-stakes and serial is safer.
- No Codex audit. Codex is not available on client machines.

## Invocation

| Form | Behavior |
|------|----------|
| `/skill:dev-build` | Auto-discover the most recent plan in `artifacts\plans\` |
| `/skill:dev-build <path>` | Execute a specific plan file |
| `/skill:dev-build <path> --dry-run` | Walk the plan, log what WOULD run, do NOT execute. Useful for last-minute review. |

## Pipeline Position

```
sys-* investigation -> dev-plan -> [APPROVE] -> dev-build -> [verify] -> /skill:sys-cleanup
```

## Variables

- `PATH_TO_PLAN` - explicit path or auto-discovered
- `PLAN_DIRECTORIES` - `artifacts\plans\`
- `LOG_PATH` - `artifacts\investigations\execution-log.md`

## Pre-flight

### Approval check (HARD GATE)

Confirm explicit approval BEFORE anything else. Required form:

```
APPROVE <plan-filename>
```

Where `<plan-filename>` matches the basename of the plan being executed (e.g. `APPROVE spooler-crash-loop-fix`). Search the last 5 conversation turns for that verbatim string.

If not found, STOP and reply:

```
Cannot execute without explicit APPROVE.

Plan: <path>

Reply with the exact line:
  APPROVE <plan-filename>

Or:
  REVISE   - to modify the plan
  ABORT    - to discard
```

A bare `APPROVE` without a filename is ambiguous and must be rejected — too risky to execute the wrong plan. Wait for the technician. Do not proceed.

### Plan discovery (if path not given)

```powershell
Get-ChildItem 'artifacts\plans\*.md' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 5 FullName, LastWriteTime
```

If multiple recent plans, ask the technician which one. If none, refuse and tell them to run `/skill:dev-plan` first.

### Plan validation

Read the plan. Verify it contains:
- `## Step by Step Tasks` section with at least one `### N.` group and `[N.M]` tasks
- `## Verification` section with `[T.N.M]` checks
- `## Rollback Plan` section
- Every task tagged `[SAFE]`, `[MODERATE]`, or `[RISKY]`
- Every non-`[SAFE]` task includes a `Rollback:` command

If any of these are missing, refuse to execute. Report what is missing.

### Re-run preflight

Re-run the deterministic preflight from dev-plan Phase 5. Plan freshness matters - the machine state may have changed since the plan was written. If any CRITICAL preflight now fails, STOP and report. Do NOT execute.

### Log header

Append to `LOG_PATH`:

```md
---

# Execution: <plan filename>

**Started:** <ISO timestamp>
**Host:** <COMPUTERNAME>
**Elevated:** <true|false>
**User:** <whoami>
**Mode:** <execute | dry-run>
**Plan SHA256:** <hash>
```

### Capture plan hash + initial elevation state

Capture both values once, before the execution loop starts:

```powershell
$planHash = (Get-FileHash -Path $PATH_TO_PLAN -Algorithm SHA256).Hash
$elevatedAtStart = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
```

Persist `$planHash` and `$elevatedAtStart` for the duration of the build. They are the integrity baseline for the mid-run checks below.

## Execution loop

For each task `[N.M]` in order:

### 1. Announce
Append to log:
```md
## [N.M] <task description>
**Risk:** <SAFE|MODERATE|RISKY>
**Started:** <ISO timestamp>
**Command:**
```
```powershell
<exact command>
```

### 2. Confirm RISKY (in execute mode)
If risk is `[RISKY]`, even with overall plan APPROVED, ask one last time:

```
About to execute RISKY task [N.M]:
  <command>

Rollback if it fails:
  <rollback command>

Type EXECUTE to run this specific task, or SKIP to skip it.
```

Wait for response. If anything other than `EXECUTE`, treat as SKIP.

### 3. Run (or dry-run)
- Execute mode: run the exact command via the pi shell (PowerShell). Capture stdout, stderr, exit code.
- Dry-run mode: append `(dry-run) would execute: <command>` to log and continue.

### 4. Log result
Append:
```md
**Completed:** <ISO timestamp>
**Exit code:** <int>
**Stdout (first 50 lines):**
<output>
**Stderr (first 50 lines):**
<output>
**Outcome:** <success | skipped | failed>
```

### 5. Update plan checkbox
On `success`, edit the plan file: change `- [ ] [N.M]` to `- [x] [N.M]` for that task. Increment the `Task Counts` line at the bottom.

### 6. Failure handling
If exit code is non-zero OR stderr indicates failure:

1. Mark task `[!] [N.M]` in the plan (failed marker).
2. Run the task's `Rollback:` command. Log it.
3. Append to log:
   ```
   **HALTED at [N.M].** Rollback executed. Remaining tasks skipped.
   ```
4. Walk back through all tasks already marked `[x]` in REVERSE order. For each one with a `Rollback:`, run it. Log every rollback execution.
5. STOP. Do not proceed to verification. Hand off to /skill:handoff with execution-log.md as the source artifact.

## Verification phase

After all `### N.` task groups complete successfully:

For each `[T.N.M]` verification check:

1. Run the verification command exactly as written.
2. Compare actual output to expected output (the line below the check item).
3. Log:
   ```md
   ## [T.N.M] <check description>
   **Expected:** <text>
   **Actual:** <captured output>
   **Result:** <PASS|FAIL>
   ```
4. On `PASS`, flip the checkbox `- [ ] [T.N.M]` -> `- [x] [T.N.M]` in the plan.
5. On `FAIL`, mark `[!] [T.N.M]`. Continue running remaining checks (do NOT halt - we need the full picture).

## Acceptance Criteria check

After verification, walk the plan's `## Acceptance Criteria` section. For each criterion, state whether it is met based on the verification results. Append the summary to the log:

```md
## Acceptance Criteria Summary

- [x] <criterion 1> - <evidence>
- [!] <criterion 2> - <gap, what failed>
```

## Final report

Append to log:
```md
## Execution Complete

**Finished:** <ISO timestamp>
**Tasks executed:** <N>
**Tasks succeeded:** <N>
**Tasks failed:** <N>
**Tasks skipped:** <N>
**Verification PASS:** <N>
**Verification FAIL:** <N>
**Acceptance:** <MET | NOT MET | PARTIAL>

**Next:**
- If MET: run /skill:sys-cleanup
- If NOT MET / PARTIAL: review log, decide whether to /skill:dev-plan a follow-up or /skill:handoff to a senior tech
```

Output the same summary to the technician.

## Constraints

- Sequential only. Never spawn parallel jobs for plan tasks.
- One failure halts execution and triggers full rollback.
- Every command must be logged BEFORE it runs. Logging is not optional.
- Never silently skip a task. SKIP requires either dry-run mode or technician input.
- Never delete the plan file after execution. It is the record of what was done.
- Never modify any file outside `artifacts\` and the explicit edit-targets listed in the plan's `## Relevant Files`.
- Respect silent operation rules from project CLAUDE.md. No GUI, no notifications, no console pauses.

## Integrity checks between groups

These checks run ONCE between each `### N.` task group, not between individual `[N.M]` tasks (too noisy). Run them after the last task of group N completes, before the first task of group N+1 starts.

### Plan file tamper check

```powershell
$currentHash = (Get-FileHash -Path $PATH_TO_PLAN -Algorithm SHA256).Hash
if ($currentHash -ne $planHash) {
    # HALT. Plan was edited mid-run. Do NOT continue.
    # Log: "Plan SHA256 changed: $planHash -> $currentHash"
    # Trigger reverse-order rollback of completed tasks.
}
```

dev-build itself flips checkboxes in the plan during execution (success/fail markers). Those edits change the hash. Re-hash AFTER your own checkbox update completes for the last task in the group, then store the new hash as the baseline for the next comparison:

```powershell
# After all checkbox flips for group N are done:
$planHash = (Get-FileHash -Path $PATH_TO_PLAN -Algorithm SHA256).Hash
```

Any unexpected hash drift (i.e. drift not preceded by dev-build's own edits) means a human or another process touched the plan. HALT.

### Elevation drop check

```powershell
$elevatedNow = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($elevatedAtStart -and -not $elevatedNow) {
    # HALT. Started elevated, now not. Token degraded or session changed.
}
```

If `$elevatedAtStart` was false and remains false, that's expected — proceed.

### Disk space check (before any RISKY task)

```powershell
$freeGB = [math]::Round((Get-Volume -DriveLetter C).SizeRemaining / 1GB, 2)
if ($freeGB -lt 1.0) {
    # HALT. Rollback may need space. Free up disk before retrying.
}
```

### Service restart timeout

Default `Start-Service` timeout is 30s. For known-slow services, use explicit poll:

```powershell
Start-Service -Name <name>
$deadline = (Get-Date).AddSeconds(120)
do {
    Start-Sleep -Seconds 2
    $status = (Get-Service -Name <name>).Status
} while ($status -ne 'Running' -and (Get-Date) -lt $deadline)
if ($status -ne 'Running') { throw "Service <name> failed to reach Running within 120s" }
```
