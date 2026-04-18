<#
.SYNOPSIS
    Pull the latest pi-win from GitHub without reinstalling Node.js or the Pi agent.
.DESCRIPTION
    Downloads the repo zip, extracts it, and robocopy's files into the install path
    while preserving artifacts/ and .env. Safe to run mid-session.
.EXAMPLE
    .\update-pi.ps1
    .\update-pi.ps1 -InstallPath "C:\working\pi" -Branch "main"
#>
param(
    [string]$InstallPath = "C:\working\pi",
    [string]$GitHubRepo  = "shreeve1/pi-win",
    [string]$Branch      = "main"
)
$ErrorActionPreference = "Continue"

function Write-Status($m) { Write-Host "[PI] $m" -ForegroundColor Cyan }
function Write-Ok($m)     { Write-Host "[OK] $m"   -ForegroundColor Green }
function Write-Warn($m)   { Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Write-Fail($m)   { Write-Host "[FAIL] $m" -ForegroundColor Red }

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

    Write-Status "Syncing files (preserving artifacts/ and .env)..."
    # /E  = include subdirs, /XD = exclude dirs, /XF = exclude files
    # /NFL /NDL /NJH /NJS /NC /NS = suppress robocopy's verbose output
    $rc = robocopy $extracted.FullName $InstallPath /E /XD artifacts /XF .env /NFL /NDL /NJH /NJS /NC /NS
    # Robocopy exit codes 0-7 are success/info; 8+ are errors
    if ($LASTEXITCODE -ge 8) {
        Write-Fail "robocopy reported errors (exit $LASTEXITCODE)"
    } else {
        Write-Ok "Files synced (robocopy exit $LASTEXITCODE)"
    }

    Write-Status ""
    Write-Ok "UPDATE COMPLETE — artifacts/ and .env preserved"
    Write-Host "  cd $InstallPath ; pi" -ForegroundColor White

} catch {
    Write-Fail "Update failed: $($_.Exception.Message)"
    exit 1
} finally {
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
    Remove-Item $tmpDir  -Recurse -Force -ErrorAction SilentlyContinue
}
