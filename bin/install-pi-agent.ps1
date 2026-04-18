<#
.SYNOPSIS
    Bootstrap and install Pi Coding Agent on a Windows workstation.
.DESCRIPTION
    Self-contained. Downloads the pi-win repo from GitHub, installs Node.js,
    Pi Coding Agent, Sysinternals, and Nmap. Silent/non-interactive.
    PS 5.1 compatible. Runs as SYSTEM or elevated user.
.EXAMPLE
    # Run inline from your RMM (no file upload needed):
    irm https://raw.githubusercontent.com/shreeve1/pi-win/main/bin/install-pi-agent.ps1 | iex

    # Or if already on disk:
    .\install-pi-agent.ps1

    # Force re-download of the repo:
    .\install-pi-agent.ps1 -Force
#>
param(
    [string]$InstallPath  = "C:\working\pi",
    [string]$GitHubRepo   = "shreeve1/pi-win",
    [string]$Branch       = "main",
    [switch]$SkipNode,
    [switch]$SkipNpmInstall,
    [switch]$Force
)
$ErrorActionPreference = "Continue"

function Write-Status($m) { Write-Host "[PI] $m" -ForegroundColor Cyan }
function Write-Ok($m)     { Write-Host "[OK] $m"   -ForegroundColor Green }
function Write-Warn($m)   { Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Write-Fail($m)   { Write-Host "[FAIL] $m" -ForegroundColor Red }

function Refresh-Path {
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH","User")
}
function Test-Cmd($n) { try { Get-Command $n -ErrorAction Stop | Out-Null; $true } catch { $false } }

# Detect context
$isAdmin  = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$user     = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$isSystem = $user -like "*SYSTEM*" -or $user -like "*NT AUTHORITY*"

Write-Status "=== Pi Agent Installer ==="
Write-Status "User: $user | Admin: $isAdmin | System: $isSystem"
Write-Status "Install path: $InstallPath"
Write-Status ""

# ── Step 0: Download repo from GitHub ──
Write-Status "Step 0: Downloading pi-win from GitHub ($GitHubRepo @ $Branch)"
$repoReady = (Test-Path (Join-Path $InstallPath "settings.json")) -and -not $Force

if ($repoReady) {
    Write-Ok "pi-win already present at $InstallPath — skipping download (use -Force to re-download)"
} else {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $zipUrl  = "https://github.com/$GitHubRepo/archive/refs/heads/$Branch.zip"
    $zipPath = Join-Path $env:TEMP "pi-win.zip"
    $tmpDir  = Join-Path $env:TEMP "pi-win-extract"

    try {
        Write-Status "Downloading $zipUrl ..."
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing -TimeoutSec 120
        Write-Ok "Downloaded $([math]::Round((Get-Item $zipPath).Length/1KB,0)) KB"

        Write-Status "Extracting..."
        if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue }
        Expand-Archive -Path $zipPath -DestinationPath $tmpDir -Force

        # GitHub zips extract to a subfolder named <repo>-<branch>
        $extracted = Get-ChildItem $tmpDir -Directory | Select-Object -First 1
        if (-not $extracted) { Write-Fail "Zip extraction produced no folder. Aborting."; exit 1 }

        # Move into place — remove existing target if Force
        if ((Test-Path $InstallPath) -and $Force) {
            Remove-Item $InstallPath -Recurse -Force -ErrorAction SilentlyContinue
        }
        if (-not (Test-Path (Split-Path $InstallPath))) {
            New-Item -ItemType Directory -Path (Split-Path $InstallPath) -Force | Out-Null
        }
        Move-Item -Path $extracted.FullName -Destination $InstallPath -Force
        Write-Ok "pi-win installed to $InstallPath"
    } catch {
        Write-Fail "GitHub download failed: $($_.Exception.Message)"
        exit 1
    } finally {
        Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
        Remove-Item $tmpDir  -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Confirm the folder is now ready
if (-not (Test-Path $InstallPath)) {
    Write-Fail "Install path $InstallPath not found after download. Aborting."
    exit 1
}
Write-Ok "pi-win folder ready at $InstallPath"

# ── Step 1: Node.js ──
if (-not $SkipNode) {
    Write-Status "Step 1: Node.js"
    Refresh-Path
    if ((Test-Cmd node) -and -not $Force) {
        Write-Ok "Node.js already installed: $(node --version 2>$null)"
    } else {
        $nodeUrl = "https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi"
        $msi     = "$env:TEMP\node-install.msi"
        Write-Status "Downloading Node.js LTS..."
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $nodeUrl -OutFile $msi -UseBasicParsing -TimeoutSec 120
            Write-Ok "Downloaded $([math]::Round((Get-Item $msi).Length/1MB,1)) MB"
        } catch {
            Write-Fail "Download failed: $($_.Exception.Message)"
            if (Test-Cmd choco) { choco install nodejs-lts -y --no-progress; Refresh-Path }
            if (-not (Test-Cmd node)) { Write-Fail "Cannot install Node.js. Aborting."; exit 1 }
        }
        if (Test-Path $msi) {
            Write-Status "Installing silently..."
            Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart ADDLOCAL=ALL" -Wait -PassThru -NoNewWindow
            Remove-Item $msi -Force -ErrorAction SilentlyContinue
            Refresh-Path
            if (Test-Cmd node) { Write-Ok "Node.js $(node --version 2>$null) installed" }
            else {
                $env:PATH = "C:\Program Files\nodejs;$env:PATH"
                if (Test-Cmd node) { Write-Ok "Node.js found after PATH fix" }
                else { Write-Fail "Node.js not found. Aborting."; exit 1 }
            }
        }
    }
    if (Test-Cmd npm) { Write-Ok "npm $(npm --version 2>$null)" }
    else { Write-Fail "npm missing"; exit 1 }
} else { Write-Status "Step 1: Skipped" }

# ── Step 2: Pi Coding Agent ──
if (-not $SkipNpmInstall) {
    Write-Status "Step 2: Pi Coding Agent"
    $out = npm install -g @mariozechner/pi-coding-agent 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "npm failed (exit $LASTEXITCODE), trying --force..."
        npm install -g @mariozechner/pi-coding-agent --force 2>&1
    }
    Refresh-Path
    # Ensure npm global prefix is on Machine PATH — under SYSTEM context npm writes
    # to SYSTEM's User PATH which is invisible to real logged-on users.
    $npmPrefix = (npm config get prefix 2>$null).Trim()
    if ($npmPrefix -and (Test-Path $npmPrefix)) {
        $machinePath = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
        if ($machinePath -notlike "*$npmPrefix*") {
            [System.Environment]::SetEnvironmentVariable("PATH", "$npmPrefix;$machinePath", "Machine")
            Write-Ok "Added $npmPrefix to Machine PATH (persistent)"
        }
        $env:PATH = "$npmPrefix;$env:PATH"
    }
    if (Test-Cmd pi) { Write-Ok "pi command available" }
    else { Write-Warn "pi not in PATH — open new shell to use" }
} else { Write-Status "Step 2: Skipped" }

# ── Step 3: Sysinternals ──
Write-Status "Step 3: Sysinternals"
$dl = Join-Path $InstallPath "bin\download-tools.ps1"
if (Test-Path $dl) { & $dl -Destination (Join-Path $InstallPath "bin") }
else { Write-Warn "download-tools.ps1 not found at $dl" }

# ── Step 3b: Nmap (portable zip, no installer) ──
Write-Status "Step 3b: Nmap"
$nmapDir = Join-Path $InstallPath "bin\nmap"
if (Test-Path (Join-Path $nmapDir "nmap.exe")) {
    Write-Ok "Nmap already present"
} else {
    # 7.92 portable zip — NSIS installer (/S) hangs under SYSTEM; zip is extract-and-run
    $nmapUrl = "https://nmap.org/dist/nmap-7.92-win32.zip"
    $nmapZip = Join-Path $env:TEMP "nmap.zip"
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Write-Status "Downloading Nmap 7.92 portable (~22 MB)..."
        Invoke-WebRequest -Uri $nmapUrl -OutFile $nmapZip -UseBasicParsing -TimeoutSec 120
        Write-Status "Extracting..."
        $tempExtract = Join-Path $env:TEMP "nmap-extract"
        if (Test-Path $tempExtract) { Remove-Item $tempExtract -Recurse -Force -ErrorAction SilentlyContinue }
        Expand-Archive -Path $nmapZip -DestinationPath $tempExtract -Force
        $extractedDir = Get-ChildItem $tempExtract -Directory | Select-Object -First 1
        if ($extractedDir -and (Test-Path (Join-Path $extractedDir.FullName "nmap.exe"))) {
            if (-not (Test-Path $nmapDir)) { New-Item -ItemType Directory -Path $nmapDir -Force | Out-Null }
            Get-ChildItem $extractedDir.FullName | Move-Item -Destination $nmapDir -Force
            Write-Ok "Nmap 7.92 extracted to $nmapDir"
        } else {
            Write-Warn "Nmap zip structure unexpected. Manual extract needed."
        }
        Remove-Item $nmapZip    -Force -ErrorAction SilentlyContinue
        Remove-Item $tempExtract -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Write-Warn "Nmap download/extract failed: $($_.Exception.Message)"
        Remove-Item $nmapZip -Force -ErrorAction SilentlyContinue
    }
}

# ── Step 3c: Web extension check ──
Write-Status "Step 3c: Web extension"
$extDir = Join-Path $InstallPath "extensions\web-fetch"
if (Test-Path (Join-Path $extDir "index.ts")) {
    Write-Ok "web-fetch extension ready"
} else { Write-Warn "web-fetch extension not found" }
$envFile = Join-Path $InstallPath ".env"
if (Test-Path $envFile) {
    if ((Get-Content $envFile -ErrorAction SilentlyContinue | Select-String "REPLACE_WITH").Count -gt 0) {
        Write-Warn "SERPER_API_KEY not set. Edit .env to enable web_search."
    }
} else { Write-Warn ".env missing — web_search unavailable" }

# ── Step 4: Verify ──
Write-Status "Step 4: Verification"
Write-Status "============================="
$ok = $true
if (Test-Cmd node) { Write-Ok "node: $(node --version 2>$null)" } else { Write-Fail "node: MISSING"; $ok = $false }
if (Test-Cmd npm)  { Write-Ok "npm: $(npm --version 2>$null)" }   else { Write-Fail "npm: MISSING";  $ok = $false }
if (Test-Cmd pi)   { Write-Ok "pi: available" }                    else { Write-Warn "pi: not in PATH (new shell needed)" }
$allFiles = (Get-ChildItem $InstallPath -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Ok "Kit: $allFiles files at $InstallPath"
$exes = @(Get-ChildItem (Join-Path $InstallPath "bin") -Filter "*.exe" -Recurse -ErrorAction SilentlyContinue)
if ($exes.Count -gt 0) { Write-Ok "Tools: $($exes.Count) executables (Sysinternals + Nmap)" } else { Write-Warn "Tools: none" }

Write-Status ""
if ($ok) {
    Write-Ok "INSTALL COMPLETE"
    Write-Host "  cd $InstallPath ; pi" -ForegroundColor White
} else { Write-Warn "INSTALL COMPLETE WITH ISSUES" }

# Set PI_CODING_AGENT_DIR
[System.Environment]::SetEnvironmentVariable("PI_CODING_AGENT_DIR", $InstallPath, "Machine")
$env:PI_CODING_AGENT_DIR = $InstallPath
Write-Ok "PI_CODING_AGENT_DIR set to $InstallPath"

# Write install log
$logDir = Join-Path $InstallPath "artifacts\investigations"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$nodeVer  = if (Test-Cmd node) { node --version 2>$null } else { "NOT FOUND" }
$npmVer   = if (Test-Cmd npm)  { npm --version 2>$null }  else { "NOT FOUND" }
$piAvail  = if (Test-Cmd pi)   { "YES" }                   else { "NO" }
$logText  = "## Pi Agent Install Log`n**Date:** $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`n**User:** $user`n**Admin:** $isAdmin`n**System Context:** $isSystem`n**Repo:** $GitHubRepo @ $Branch`n**Node.js:** $nodeVer`n**npm:** $npmVer`n**pi command:** $piAvail`n**Install Path:** $InstallPath`n**Tools:** $(if ($exes.Count -gt 0) { "$($exes.Count) executables" } else { 'none' })`n**Status:** $(if ($ok) { 'SUCCESS' } else { 'PARTIAL' })"
$logText | Out-File -FilePath (Join-Path $logDir "install-log.md") -Encoding UTF8
