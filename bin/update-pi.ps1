<#
.SYNOPSIS
    Pull the latest pi-win from GitHub and ensure Node.js meets Pi's minimum version.
.DESCRIPTION
    Downloads the repo zip, extracts it, and robocopy's files into the install path
    while preserving artifacts/ and .env. Upgrades Node.js when below Pi's
    minimum supported version. Safe to run mid-session.
.EXAMPLE
    .\update-pi.ps1
    .\update-pi.ps1 -InstallPath "C:\ProgramData\pi-win" -Branch "main"
#>
param(
    [string]$InstallPath = "C:\ProgramData\pi-win",
    [string]$GitHubRepo  = "shreeve1/pi-win",
    [string]$Branch      = "main"
)
$ErrorActionPreference = "Continue"
$RequiredNodeVersion = "22.19.0"
$NodeDownloadVersion = "22.19.0"

function Write-Status($m) { Write-Host "[PI] $m" -ForegroundColor Cyan }
function Write-Ok($m)     { Write-Host "[OK] $m"   -ForegroundColor Green }
function Write-Warn($m)   { Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Write-Fail($m)   { Write-Host "[FAIL] $m" -ForegroundColor Red }
function Refresh-Path {
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH","User")
}
function Test-Cmd($n) { try { Get-Command $n -ErrorAction Stop | Out-Null; $true } catch { $false } }
function Get-NodeVersion {
    if (-not (Test-Cmd node)) { return $null }
    $raw = (node --version 2>$null)
    if (-not $raw) { return $null }
    try { return [version]($raw.Trim().TrimStart("v")) } catch { return $null }
}
function Test-NodeVersionReady {
    $nodeVersion = Get-NodeVersion
    if (-not $nodeVersion) { return $false }
    return ($nodeVersion -ge [version]$RequiredNodeVersion)
}
function Install-RequiredNode {
    Refresh-Path
    if (Test-NodeVersionReady) {
        Write-Ok "Node.js already meets requirement: $(node --version 2>$null)"
        return
    }

    $existingNodeVersion = Get-NodeVersion
    if ($existingNodeVersion) {
        Write-Warn "Node.js v$existingNodeVersion found; Pi 0.75.0+ requires >= v$RequiredNodeVersion. Upgrading."
    } else {
        Write-Warn "Node.js not found; installing v$NodeDownloadVersion."
    }

    if (-not (Test-Reachable "https://nodejs.org")) {
        Write-Fail "Cannot reach nodejs.org to install Node.js >= v$RequiredNodeVersion. Aborting."
        exit 1
    }

    $nodeUrl = "https://nodejs.org/dist/v$NodeDownloadVersion/node-v$NodeDownloadVersion-x64.msi"
    $msi = Join-Path $env:TEMP "node-install.msi"
    try {
        Write-Status "Downloading Node.js $NodeDownloadVersion LTS..."
        Invoke-WebRequest -Uri $nodeUrl -OutFile $msi -UseBasicParsing -TimeoutSec 120
        Write-Ok "Downloaded $([math]::Round((Get-Item $msi).Length/1MB,1)) MB"
        Write-Status "Installing silently..."
        Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart ADDLOCAL=ALL" -Wait -PassThru -NoNewWindow
        Refresh-Path
        if (-not (Test-NodeVersionReady)) {
            $env:PATH = "C:\Program Files\nodejs;$env:PATH"
        }
        if (Test-NodeVersionReady) { Write-Ok "Node.js $(node --version 2>$null) installed" }
        else { Write-Fail "Node.js >= v$RequiredNodeVersion not found after install. Aborting."; exit 1 }
    } catch {
        Write-Fail "Node.js install failed: $($_.Exception.Message)"
        exit 1
    } finally {
        Remove-Item $msi -Force -ErrorAction SilentlyContinue
    }
}

Write-Status "=== Pi Update ==="
Write-Status "Install path : $InstallPath"
Write-Status "Repo         : $GitHubRepo @ $Branch"
Write-Status ""

# Pre-flight
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Test-Reachable($url) {
    try {
        $req = [System.Net.WebRequest]::Create($url)
        $req.Method = "HEAD"
        $req.Timeout = 5000
        [void]$req.GetResponse()
        $true
    } catch { $false }
}

if (-not (Test-Reachable "https://github.com")) {
    Write-Fail "Cannot reach github.com. Check network/proxy. Aborting."
    exit 1
}
Write-Ok "github.com reachable"

if (-not (Test-Path $InstallPath)) {
    Write-Fail "$InstallPath not found. Run install-pi-agent.ps1 first."
    exit 1
}

Install-RequiredNode

# Download zip
$zipUrl  = "https://github.com/$GitHubRepo/archive/refs/heads/$Branch.zip"
$zipPath = Join-Path $env:TEMP "pi-win-update.zip"
$tmpDir  = Join-Path $env:TEMP "pi-win-update-extract"

try {
    Write-Status "Downloading $zipUrl ..."
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing -TimeoutSec 120
    Write-Ok "Downloaded $([math]::Round((Get-Item $zipPath).Length/1KB,0)) KB"

    Write-Status "Extracting..."
    if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue }
    Expand-Archive -Path $zipPath -DestinationPath $tmpDir -Force

    $extracted = Get-ChildItem $tmpDir -Directory | Select-Object -First 1
    if (-not $extracted) { Write-Fail "Zip extraction produced no folder. Aborting."; exit 1 }

    Write-Status "Syncing files (preserving artifacts/, .env, settings.json, auth.json)..."
    # /E  = include subdirs, /XD = exclude dirs, /XF = exclude files
    # /NFL /NDL /NJH /NJS /NC /NS = suppress robocopy's verbose output
    # settings.json and auth.json are installer-managed per-deployment state;
    # excluding them stops updates from clobbering defaultProvider/defaultModel
    # or wiping API keys. models.json IS updated so new bundled models propagate.
    $rc = robocopy $extracted.FullName $InstallPath /E /XD artifacts /XF .env settings.json auth.json /NFL /NDL /NJH /NJS /NC /NS
    # Robocopy exit codes 0-7 are success/info; 8+ are errors
    if ($LASTEXITCODE -ge 8) {
        Write-Fail "robocopy reported errors (exit $LASTEXITCODE)"
    } else {
        Write-Ok "Files synced (robocopy exit $LASTEXITCODE)"
    }

    # Pi loads its operating instructions from AGENTS.md. In the repo AGENTS.md
    # is a symlink to CLAUDE.md, but GitHub zip extraction yields a real file
    # that can drift from CLAUDE.md if the symlink target changed between
    # commits. Re-materialize AGENTS.md from CLAUDE.md for parity with the
    # installer's behaviour.
    $sourceAgentFile    = Join-Path $InstallPath "CLAUDE.md"
    $installedAgentFile = Join-Path $InstallPath "AGENTS.md"
    if (Test-Path $sourceAgentFile) {
        Copy-Item -Path $sourceAgentFile -Destination $installedAgentFile -Force
        Write-Ok "AGENTS.md refreshed from CLAUDE.md"
    }

    Write-Status ""
    Write-Ok "UPDATE COMPLETE - artifacts/, .env, settings.json, auth.json preserved"
    Write-Host "  cd $InstallPath ; pi" -ForegroundColor White

} catch {
    Write-Fail "Update failed: $($_.Exception.Message)"
    exit 1
} finally {
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
    Remove-Item $tmpDir  -Recurse -Force -ErrorAction SilentlyContinue
}
