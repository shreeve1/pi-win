---
name: sys-report
description: Consolidated investigation report with remediation plan and approval gate.
---
# Sys Report
Use after investigation completes. Gather all artifacts and synthesize.
## Generate Report
Write to artifacts/investigations/consolidated-report.md:
1. Executive Summary  2. Problem Statement  3. System Overview  4. Findings (Critical/High/Medium/Low)
5. Root Cause Analysis  6. Remediation Plan ([SAFE]/[MODERATE]/[RISKY] with command, result, rollback)
7. Verification  8. Unanswered Questions
## Approval Gate
Present plan. Ask: APPROVE to execute, REVISE to modify, ABORT to cancel.
Wait for response. Do not proceed without APPROVE.
