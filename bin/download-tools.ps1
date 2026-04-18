param([string]$Destination = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Destination)) { New-Item -ItemType Directory -Path $Destination -Force | Out-Null }
$tools = @('pslist64.exe','PsService64.exe','PsInfo64.exe','autorunsc64.exe','tcpvcon64.exe','handle64.exe','sigcheck64.exe','psloglist64.exe','Listdlls64.exe')
$baseUrl = 'https://live.sysinternals.com'
$downloaded = 0; $failed = 0
Write-Host ""; Write-Host "=== Sysinternals Tool Download ===" -ForegroundColor Cyan; Write-Host "Destination: $Destination"; Write-Host ""
foreach ($tool in $tools) {
    $url = "$baseUrl/$tool"; $outPath = Join-Path $Destination $tool
    try {
        Write-Host "Downloading $tool..." -NoNewline
        Invoke-WebRequest -Uri $url -OutFile $outPath -UseBasicParsing -TimeoutSec 30
        if (Test-Path $outPath) { $sizeKB = [math]::Round((Get-Item $outPath).Length / 1KB, 1); Write-Host " OK ($sizeKB KB)" -ForegroundColor Green; $downloaded++ }
        else { Write-Host " FAILED" -ForegroundColor Red; $failed++ }
    } catch { Write-Host " FAILED ($($_.Exception.Message))" -ForegroundColor Red; $failed++ }
}
Write-Host ""; Write-Host "Downloaded: $downloaded of $($tools.Count) | Failed: $failed" -ForegroundColor Cyan
if ($failed -eq 0) { Write-Host "All tools ready. ~3.9 MB. Use -accepteula on first run." -ForegroundColor Green }
