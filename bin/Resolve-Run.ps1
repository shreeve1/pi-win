<#
.SYNOPSIS
    Resolve (or create) the current pi-win investigation run directory.

.DESCRIPTION
    Single source of truth for the run-scoped artifact layout documented in
    AGENTS.md / CLAUDE.md ("Output"). Reads/writes the run pointer
    artifacts\investigations\.current-run and guarantees the standard subdirs
    (hosts\, scans\, logs\) and the per-host dir exist.

    Behavior:
      -Slug given  -> start a NEW run (sys-intake only). run-id =
                      <UTC yyyyMMdd-HHmmss>-<kebab-slug>; pointer overwritten.
      no -Slug     -> reuse the run named in .current-run; if none exists,
                      create an "<UTC ts>-adhoc" run.

    Dot-source it so the caller picks up $runId, $RUN, $HOSTDIR:
        . bin\Resolve-Run.ps1 | Out-Null              # reuse / adhoc
        . bin\Resolve-Run.ps1 -Slug 'slow-boot' | Out-Null   # intake: new run

    Or call it for the object form (when not dot-sourcing):
        $r = & bin\Resolve-Run.ps1 ; $r.Run

.OUTPUTS
    [pscustomobject] with RunId, Run, HostDir.
#>
[CmdletBinding()]
param(
    [string]$Slug,
    [string]$HostName = $(if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { 'localhost' }),
    [string]$Root = 'artifacts\investigations'
)

$ptr = Join-Path $Root '.current-run'
New-Item -ItemType Directory -Path $Root -Force | Out-Null

if ($Slug) {
    $clean = ($Slug.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
    if (-not $clean) { $clean = 'investigation' }
    $runId = '{0}-{1}' -f ((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')), $clean
    Set-Content -Path $ptr -Value $runId -Encoding UTF8
}
elseif (Test-Path $ptr) {
    $runId = (Get-Content $ptr -Raw).Trim()
}
else {
    $runId = '{0}-adhoc' -f ((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss'))
    Set-Content -Path $ptr -Value $runId -Encoding UTF8
}

$RUN = Join-Path $Root $runId
foreach ($d in @('hosts', 'scans', 'logs')) {
    New-Item -ItemType Directory -Path (Join-Path $RUN $d) -Force | Out-Null
}
$HOSTDIR = Join-Path $RUN ('hosts\' + $HostName)
New-Item -ItemType Directory -Path $HOSTDIR -Force | Out-Null

[pscustomobject]@{ RunId = $runId; Run = $RUN; HostDir = $HOSTDIR }
