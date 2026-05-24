<#
.SYNOPSIS
    Bootstrap and install Pi Coding Agent on a Windows workstation.
.DESCRIPTION
    Self-contained. Pre-flight checks connectivity, downloads the pi-win repo from
    GitHub, installs Node.js, Pi Coding Agent, Sysinternals, and Nmap.
    Silent/non-interactive. PS 5.1 compatible. Runs as SYSTEM or elevated user.
.EXAMPLE
    # Run inline from your RMM - no file upload needed:
    irm https://raw.githubusercontent.com/shreeve1/pi-win/main/bin/install-pi-agent.ps1 | iex

    # Fill in keys directly in the param defaults (recommended for RMM paste-deploy):
    #   [string]$ModelApiKey  = "your-llm-key-here"
    #   [string]$SerperApiKey = "your-serper-key-here"

    # Or pass at runtime:
    .\install-pi-agent.ps1 -ModelApiKey "your-llm-key" -SerperApiKey "your-serper-key"

    # Or pass a model key in one line from RMM:
    $s = irm https://raw.githubusercontent.com/shreeve1/pi-win/main/bin/install-pi-agent.ps1; & ([scriptblock]::Create($s)) -ModelProvider "zai" -ModelApiKey "your-llm-key"

    # Or load keys from a local .env file:
    #   MODEL_PROVIDER=zai
    #   MODEL_API_KEY=your-llm-key
    #   SERPER_API_KEY=your-serper-key
    .\install-pi-agent.ps1 -EnvFile "C:\ProgramData\pi-win\.env"

    # Force re-download of the repo:
    .\install-pi-agent.ps1 -Force
#>
param(
    [string]$InstallPath  = "C:\ProgramData\pi-win",
    [string]$GitHubRepo   = "shreeve1/pi-win",
    [string]$Branch       = "main",
    [string]$ModelProvider = "zai",  # provider name (zai, openai, anthropic, etc.)
    [string]$ModelApiKey  = "",      # FILL IN before pasting into RMM (LLM provider key -> auth.json)
    [string]$SerperApiKey = "",      # FILL IN before pasting into RMM (Serper web search -> .env)
    [string]$EnvFile      = "",      # Optional .env file with MODEL_PROVIDER, MODEL_API_KEY, SERPER_API_KEY
    [switch]$SkipNode,
    [switch]$SkipNpmInstall,
    [switch]$Force
)
$ErrorActionPreference = "Continue"
$skipNmap = $false

function Write-Status($m) { Write-Host "[PI] $m" -ForegroundColor Cyan }
function Write-Ok($m)     { Write-Host "[OK] $m"   -ForegroundColor Green }
function Write-Warn($m)   { Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Write-Fail($m)   { Write-Host "[FAIL] $m" -ForegroundColor Red }

function Refresh-Path {
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH","User")
}
function Test-Cmd($n) { try { Get-Command $n -ErrorAction Stop | Out-Null; $true } catch { $false } }

function Read-DotEnv($Path) {
    $values = @{}
    if (-not (Test-Path $Path)) { return $values }

    foreach ($rawLine in (Get-Content $Path -ErrorAction SilentlyContinue)) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith("#")) { continue }
        if ($line.StartsWith("export ")) { $line = $line.Substring(7).Trim() }

        $equalsIndex = $line.IndexOf("=")
        if ($equalsIndex -lt 1) { continue }

        $key = $line.Substring(0, $equalsIndex).Trim()
        $value = $line.Substring($equalsIndex + 1).Trim()
        if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { continue }

        if ($value.Length -ge 2) {
            $first = $value.Substring(0, 1)
            $last = $value.Substring($value.Length - 1, 1)
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }

        $values[$key] = $value
    }

    return $values
}

# Detect context
$isAdmin  = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$user     = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$isSystem = $user -like "*SYSTEM*" -or $user -like "*NT AUTHORITY*"

Write-Status "=== Pi Agent Installer ==="
Write-Status "User: $user | Admin: $isAdmin | System: $isSystem"
Write-Status "Install path: $InstallPath"
Write-Status ""

# -- Pre-flight: Connectivity --
Write-Status "Pre-flight: Connectivity check"
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
    Write-Fail "Cannot reach github.com - required for repo download. Check network/proxy. Aborting."
    exit 1
}
Write-Ok "github.com reachable"

if (-not (Test-Reachable "https://nodejs.org")) {
    Write-Warn "Cannot reach nodejs.org - Node.js download will be skipped."
    $SkipNode = $true
} else { Write-Ok "nodejs.org reachable" }

if (-not (Test-Reachable "https://nmap.org")) {
    Write-Warn "Cannot reach nmap.org - Nmap download will be skipped."
    $skipNmap = $true
} else { Write-Ok "nmap.org reachable" }

# -- Step 0: Download repo from GitHub --
Write-Status "Step 0: Downloading pi-win from GitHub ($GitHubRepo @ $Branch)"
$repoReady = (Test-Path (Join-Path $InstallPath "settings.json")) -and -not $Force

if ($repoReady) {
    Write-Ok "pi-win already present at $InstallPath - skipping download (use -Force to re-download)"
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

        # Move into place - remove existing target if Force
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

# Pi reads AGENTS.md from the working directory tree. Keep the repo source as
# CLAUDE.md, but materialize AGENTS.md only in the installed agent directory.
$sourceAgentFile = Join-Path $InstallPath "CLAUDE.md"
$installedAgentFile = Join-Path $InstallPath "AGENTS.md"
if (Test-Path $sourceAgentFile) {
    Copy-Item -Path $sourceAgentFile -Destination $installedAgentFile -Force
    Write-Ok "AGENTS.md written in install directory"
} else {
    Write-Warn "CLAUDE.md not found; AGENTS.md not written"
}

# -- .env setup (local deploy secrets) --
$activeEnvFile = if ($EnvFile) { $EnvFile } else { Join-Path $InstallPath ".env" }
$envValues = @{}
if (Test-Path $activeEnvFile) {
    $envValues = Read-DotEnv $activeEnvFile
    $loadedEnvKeys = @()

    if ($envValues.ContainsKey("MODEL_PROVIDER") -and $envValues["MODEL_PROVIDER"] -and -not $PSBoundParameters.ContainsKey("ModelProvider")) {
        $ModelProvider = $envValues["MODEL_PROVIDER"]
        $loadedEnvKeys += "MODEL_PROVIDER"
    }

    if (-not $ModelApiKey) {
        if ($envValues.ContainsKey("MODEL_API_KEY") -and $envValues["MODEL_API_KEY"]) {
            $ModelApiKey = $envValues["MODEL_API_KEY"]
            $loadedEnvKeys += "MODEL_API_KEY"
        } else {
            $providerKeyName = (($ModelProvider.ToUpperInvariant() -replace '[^A-Z0-9]', '_') + "_API_KEY")
            if ($envValues.ContainsKey($providerKeyName) -and $envValues[$providerKeyName]) {
                $ModelApiKey = $envValues[$providerKeyName]
                $loadedEnvKeys += $providerKeyName
            }
        }
    }

    if ((-not $SerperApiKey) -and $envValues.ContainsKey("SERPER_API_KEY") -and $envValues["SERPER_API_KEY"]) {
        $SerperApiKey = $envValues["SERPER_API_KEY"]
        $loadedEnvKeys += "SERPER_API_KEY"
    }

    if ($loadedEnvKeys.Count -gt 0) {
        Write-Ok ".env loaded from $activeEnvFile ($($loadedEnvKeys -join ', '))"
    } else {
        Write-Ok ".env loaded from $activeEnvFile"
    }
} elseif ($EnvFile) {
    Write-Warn ".env file not found at $EnvFile"
}

# -- auth.json setup (LLM provider key) --
if ($ModelApiKey) {
    $authFile = Join-Path $InstallPath "auth.json"
    $authShouldWrite = $Force -or -not (Test-Path $authFile)
    $authObject = @{}

    if (Test-Path $authFile) {
        try {
            $authText = Get-Content $authFile -Raw -ErrorAction SilentlyContinue
            if ($authText -and $authText.Trim()) {
                $parsedAuth = $authText | ConvertFrom-Json -ErrorAction Stop
                foreach ($prop in $parsedAuth.PSObject.Properties) { $authObject[$prop.Name] = $prop.Value }

                if (-not $authShouldWrite) {
                    if (-not $authObject.ContainsKey($ModelProvider)) {
                        $authShouldWrite = $true
                    } else {
                        $providerAuth = $authObject[$ModelProvider]
                        $providerKey = $null
                        if ($providerAuth -and $providerAuth.PSObject.Properties["key"]) {
                            $providerKey = $providerAuth.PSObject.Properties["key"].Value
                        }
                        if (-not $providerKey) { $authShouldWrite = $true }
                    }
                }
            } else {
                $authShouldWrite = $true
            }
        } catch {
            $authShouldWrite = $true
            $authObject = @{}
        }
    }

    if ($authShouldWrite) {
        $authObject[$ModelProvider] = @{ type = "api_key"; key = $ModelApiKey }
        $authObject | ConvertTo-Json -Depth 5 | Out-File -FilePath $authFile -Encoding UTF8
        Write-Ok "auth.json written with model API key"
    } else {
        Write-Ok "auth.json already has $ModelProvider key - skipping (use -Force to overwrite)"
    }
}

# -- .env setup (Serper web search key) --
if ($SerperApiKey) {
    $envFile = Join-Path $InstallPath ".env"
    $existingContent = if (Test-Path $envFile) { Get-Content $envFile -Raw -ErrorAction SilentlyContinue } else { "" }
    $hasRealKey = $existingContent -match "SERPER_API_KEY=\S+" -and $existingContent -notmatch "REPLACE_WITH"
    if (-not $hasRealKey) {
        $lines = if (Test-Path $envFile) { @(Get-Content $envFile -ErrorAction SilentlyContinue) } else { @() }
        $lines = @($lines | Where-Object { $_ -notmatch "^SERPER_API_KEY=" }) + "SERPER_API_KEY=$SerperApiKey"
        $lines | Out-File -FilePath $envFile -Encoding UTF8
        Write-Ok ".env written with SERPER_API_KEY (other keys preserved)"
    } else {
        Write-Ok ".env already has a key - skipping (use -Force to overwrite)"
    }
}

# -- Step 1: Node.js --
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

# -- Step 2: Pi Coding Agent --
if (-not $SkipNpmInstall) {
    Write-Status "Step 2: Pi Coding Agent"
    $out = npm install -g @earendil-works/pi-coding-agent 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "npm failed (exit $LASTEXITCODE), trying --force..."
        npm install -g @earendil-works/pi-coding-agent --force 2>&1
    }
    Refresh-Path
    # Ensure npm global prefix is on Machine PATH - under SYSTEM context npm writes
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
    else { Write-Warn "pi not in PATH - open new shell to use" }
} else { Write-Status "Step 2: Skipped" }

$profilePath = Join-Path $PsHome "Profile.ps1"
$profileBlock = @'
# pi-win: run pi from the machine-wide agent directory so AGENTS.md loads.
function pi {
    $machinePath = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
    $userPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
    $pathParts = @($machinePath, $userPath, $env:PATH) | Where-Object { $_ }
    $env:PATH = ($pathParts -join ";")

    $piInstallPath = [System.Environment]::GetEnvironmentVariable("PI_CODING_AGENT_DIR", "Machine")
    if (-not $piInstallPath) { $piInstallPath = "C:\ProgramData\pi-win" }
    $env:PI_CODING_AGENT_DIR = $piInstallPath

    $piCommand = Get-Command pi.cmd -ErrorAction SilentlyContinue
    if (-not $piCommand) {
        throw "pi.cmd not found after refreshing PATH from Machine and User environment"
    }

    Push-Location $piInstallPath
    try {
        & $piCommand.Source @args
    } finally {
        Pop-Location
    }
}
'@

$profileUpdated = $false
if (Test-Path $profilePath) {
    $profileText = Get-Content $profilePath -Raw -ErrorAction SilentlyContinue
    $profilePattern = '(?ms)^# pi-win: run pi from the machine-wide agent directory so AGENTS\.md loads\.\r?\nfunction pi \{.*?^\}\r?\n?'
    $profileMatch = [regex]::Match($profileText, $profilePattern)
    if ($profileMatch.Success) {
        $replacement = $profileBlock.TrimEnd() + [Environment]::NewLine
        $newProfileText = $profileText.Remove($profileMatch.Index, $profileMatch.Length).Insert($profileMatch.Index, $replacement)
        Set-Content -Path $profilePath -Value $newProfileText -Encoding UTF8
        $profileUpdated = $true
        Write-Ok "PowerShell all-users profile wrapper updated at $profilePath"
    }
}

$profileHasPiWrapper = (Test-Path $profilePath) -and (Select-String -Path $profilePath -Pattern 'function\s+pi\s*\{' -Quiet -ErrorAction SilentlyContinue)
if ((-not $profileUpdated) -and (-not $profileHasPiWrapper)) {
    Add-Content -Path $profilePath -Value $profileBlock -Encoding UTF8
    Write-Ok "PowerShell all-users profile wraps pi at $profilePath"
} else {
    if (-not $profileUpdated) { Write-Ok "PowerShell all-users profile already wraps pi" }
}

# -- Step 3: Sysinternals --
Write-Status "Step 3: Sysinternals"
$dl = Join-Path $InstallPath "bin\download-tools.ps1"
if (Test-Path $dl) { & $dl -Destination (Join-Path $InstallPath "bin") }
else { Write-Warn "download-tools.ps1 not found at $dl" }

# -- Step 3b: Nmap (portable zip, no installer) --
Write-Status "Step 3b: Nmap"
$nmapDir = Join-Path $InstallPath "bin\nmap"
if ($skipNmap) {
    Write-Warn "Nmap skipped - nmap.org unreachable"
} elseif (Test-Path (Join-Path $nmapDir "nmap.exe")) {
    Write-Ok "Nmap already present"
} else {
    # 7.92 portable zip - NSIS installer (/S) hangs under SYSTEM; zip is extract-and-run
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

# -- Step 3c: Web extension check --
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
} else { Write-Warn ".env missing - web_search unavailable" }

# -- Step 4: Verify --
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
