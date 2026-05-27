---
name: dev-diagnose
description: Disciplined diagnosis loop for hard Windows bugs and performance regressions on client workstations. Reproduce -> minimise -> hypothesise -> instrument -> propose fix. Stops at Phase 5 for human approval (per pi-win 4-phase workflow). Use when a single sys-* skill is not enough to find root cause, or when a problem reproduces only under specific conditions.
---

# Dev Diagnose

A discipline for hard Windows bugs and performance regressions. This skill complements the `sys-*` skills: those gather breadth, this drives depth on a single problem until root cause is confirmed.

Adheres to pi-win 4-phase workflow. **Phases 1-4 of this skill are Phase 1 of the pi-win workflow (read-only).** Phase 5 (fix) is gated behind the standard APPROVE/REVISE/ABORT prompt and only runs after technician approval.

## Phase 1 - Build a feedback loop

**This is the skill.** Everything else is mechanical. If you have a fast, deterministic pass/fail signal for the bug, you will find the cause. If you do not, no amount of staring at event logs will save you.

Spend disproportionate effort here. Be aggressive. Be creative.

### Ways to construct a Windows-friendly feedback loop

Try in roughly this order:

1. **Pester test** at whatever seam reaches the bug (`Invoke-Pester`). Best for PowerShell-only repros.
2. **Single-command repro** — one PowerShell line that produces the bug deterministically (e.g. `Invoke-WebRequest`, `Test-NetConnection`, `Get-Service`, `Get-WinEvent` filter).
3. **Replay a captured event/payload.** Save the failing event XML from `wevtutil`, a captured HTTP request, or a registry export, then replay through the same code path.
4. **`Measure-Command` harness.** For performance regressions, wrap the suspect operation: `Measure-Command { <op> } | Select-Object TotalMilliseconds`. Run 10x, compute mean + stddev.
5. **Bisection harness.** If the bug appeared between two known states (KB update, driver version, GPO change), automate "set state X, check, repeat" so a human can drive the bisection.
6. **Differential loop.** Run the same operation on a known-good machine vs the failing machine, diff outputs (`Compare-Object`).
7. **Stress loop.** For non-deterministic bugs: run the trigger 100x with `1..100 | ForEach-Object { ... }`. A 1%-flake bug becomes a 60%-flake bug after enough parallelism.

Do NOT use:
- Interactive GUI debuggers (violates silent operation rules)
- Anything that prompts the user or shows a window
- Sysinternals GUI variants (use the CLI 64 versions in `bin\`)

### Iterate on the loop itself

Once you have a loop, ask:

- Can I make it faster? Cache the diagnostic state. Skip unrelated init.
- Can I make the signal sharper? Assert on the specific symptom (exit code, exact error text), not "didn't crash".
- Can I make it more deterministic? Pin time with mocks, freeze network with `New-NetFirewallRule -Block` (with rollback), capture event log snapshot first.

A 30-second flaky loop is barely better than no loop. A 2-second deterministic loop is a debugging superpower.

### Non-deterministic bugs

Goal is not a clean repro but a **higher reproduction rate**. Loop the trigger, parallelise with PowerShell jobs (`Start-Job`), add stress (`-Parallel` in PS 7, or N background jobs in 5.1). 50%-flake is debuggable, 1% is not.

### When you genuinely cannot build a loop

Stop and say so explicitly. List what you tried. Ask the technician for:
- Access to a second machine that reproduces it (RDP / Live Connect ID)
- A captured artifact (event log export `.evtx`, network trace `.etl`, crash dump `.dmp`, registry hive)
- Permission to add temporary instrumentation (with rollback) - requires APPROVE

Do not proceed to hypothesise without a loop.

## Phase 2 - Reproduce

Run the loop. Watch the bug appear.

Confirm:

- [ ] Loop produces the failure mode the **technician** described - not a similar one nearby. Wrong bug = wrong fix.
- [ ] Failure is reproducible across multiple runs (or, for non-deterministic, at high enough rate to debug).
- [ ] You captured the exact symptom (error message, exit code, slow timing) so Phase 5 can verify the fix actually addresses it.

Do not proceed until you reproduce.

## Phase 3 - Hypothesise

Generate **3-5 ranked hypotheses** before testing any. Single-hypothesis generation anchors on the first plausible idea.

Each hypothesis must be **falsifiable**: state the prediction.

> Format: "If <X> is the cause, then <changing Y> will make the bug disappear / <changing Z> will make it worse."

If you cannot state the prediction, the hypothesis is a vibe. Discard or sharpen.

Common Windows hypothesis categories:
- Permissions (ACL, registry permissions, service account)
- GPO / policy changes (recent `gpresult` output)
- Driver/KB updates (check `Get-Hotfix`, `pnputil /enum-drivers`)
- DNS / network changes (`Get-DnsClientServerAddress`, `Get-NetRoute`)
- Service state (dependencies, recovery actions)
- File / registry corruption (`sfc /verifyonly`, `dism /online /cleanup-image /scanhealth`)
- Antivirus / EDR interference (check exclusion list, recent definition updates)

Show the ranked list to the technician before testing. They may know one was already ruled out, or that a recent change matches #3. Cheap checkpoint, big time saver.

## Phase 4 - Instrument

Each probe must map to a specific prediction from Phase 3. **Change one variable at a time.**

Tool preference (read-only, Phase 1 of pi-win workflow):

1. **`Get-WinEvent` with `FilterHashtable`** - targeted log query at the boundary that distinguishes hypotheses.
2. **Sysinternals trace** - `procmon` is GUI only (skip). Use `handle64.exe`, `tcpvcon64.exe`, `Listdlls64.exe -u` for unsigned DLL detection.
3. **Performance counters** - `Get-Counter` for live perf, `typeperf -sc 60` for short captures.
4. **Targeted logging in PowerShell** - `Set-PSDebug -Trace 1` is global and noisy, prefer wrapping the suspect call in `try/catch` with explicit `Write-Verbose`.

Never "log everything and grep". Targeted only.

**Tag every diagnostic artifact** with a unique prefix and timestamp:

```powershell
$tag = "diag-$([guid]::NewGuid().ToString('N').Substring(0,6))"
"$tag $(Get-Date -Format o) <message>" | Out-File -Append "artifacts\investigations\$tag.log" -Encoding UTF8
```

Cleanup at the end is a single `Remove-Item artifacts\investigations\diag-*.log`.

**Performance branch.** For perf regressions, logs are usually wrong. Establish a baseline measurement first, then bisect:

```powershell
$baseline = 1..10 | ForEach-Object { (Measure-Command { <op> }).TotalMilliseconds }
($baseline | Measure-Object -Average -Maximum -Minimum) | Format-Table
```

## Phase 5 - Propose fix + regression test

**STOP. PHASE 1 (READ-ONLY) ENDS HERE.**

Do NOT apply any fix. Generate a remediation plan and hand off to `/skill:sys-report` for the standard 4-phase APPROVE gate.

The plan you generate must include:

1. **Hypothesis confirmed** - state which Phase 3 hypothesis matched the evidence.
2. **Proposed fix** - exact PowerShell command(s) with `[SAFE]` / `[MODERATE]` / `[RISKY]` tag.
3. **Regression test** - a PowerShell command the technician can run after the fix to verify the bug no longer reproduces. This is the Phase 1 feedback loop captured as a one-liner.
4. **Rollback command** - what to run if the fix causes a new problem.
5. **Cleanup** - which diagnostic artifacts to remove (`diag-*.log`, temp registry exports, etc.).

Write the plan to `artifacts\plans\diagnose-<short-name>.md`. Reference the feedback loop, the confirmed hypothesis, and the test that will verify the fix.

## Phase 6 - After approval (post-APPROVE only)

Only if the technician APPROVED in Phase 3 of the pi-win workflow:

- [ ] Apply the fix exactly as planned.
- [ ] Re-run the Phase 1 feedback loop. Confirm the bug no longer reproduces.
- [ ] Run the regression test. Confirm pass.
- [ ] Remove all `diag-*` diagnostic artifacts created during Phase 4.
- [ ] Append outcome to `artifacts\investigations\execution-log.md`.

Then ask: **what would have prevented this bug?** Note in the execution log if the root cause was:
- A missing monitor (e.g. event log subscription)
- A missing baseline (e.g. no perf counter history)
- An architectural issue with the client environment (e.g. GPO scope too broad)

Record the recommendation. Do NOT auto-implement.

## Constraints

- Phase 1-4 are READ-ONLY. Per pi-win silent operation rules: no GUI tools, no notifications, no desktop visibility.
- All diagnostic output goes to `artifacts\investigations\`.
- Never access personal user data per project CLAUDE.md privacy rules.
- If you discover evidence of active compromise during diagnosis: STOP, label `[CRITICAL-SECURITY]`, hand off to technician without remediation.
