# Force 1.0.501 — load test suite. No exit.
$ErrorActionPreference = 'Stop'
$Ref = 'd41c40cf7fbe3dfdaf60261473d2ae33cfe4e7d3'
$Expected = '1.0.501'
$App = 'C:\Apps\Mirae Messenger\dist\MiraeMessenger-win32-x64\resources\app'
$Base = "https://raw.githubusercontent.com/dragotigree/mirae-messenger/$Ref"
$Bust = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$files = @(
  'main.js','preload.js','index.html','package.json','version.json',
  'mobile_server.js','toast.html','toast-preload.js','lib/minimal-xlsx.js',
  'excalidraw-editor.html','preload-excalidraw.js',
  'scripts/load-sim.js','scripts/run-load-sim.ps1','scripts/stress-presence-persist.js'
)
Write-Host "=== FORCE 1.0.501 (load test suite) ===" -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath (Join-Path $App 'index.html'))) { throw "missing $App" }
Get-Process -Name 'MiraeMessenger','electron' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$wc = New-Object System.Net.WebClient
$wc.Headers['User-Agent'] = 'MiraeForce501'
$wc.Headers['Cache-Control'] = 'no-cache'
$wc.CachePolicy = New-Object System.Net.Cache.RequestCachePolicy([System.Net.Cache.RequestCacheLevel]::NoCacheNoStore)
foreach ($rel in $files) {
  $url = "$Base/$($rel -replace '\\','/')?t=$Bust"
  $dst = Join-Path $App ($rel -replace '/','\')
  $dir = Split-Path -Parent $dst
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  Write-Host "  $rel"
  $wc.DownloadFile($url, $dst)
}
$ver = (Get-Content -LiteralPath (Join-Path $App 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$main = Get-Content -LiteralPath (Join-Path $App 'main.js') -Raw -Encoding UTF8
$html = Get-Content -LiteralPath (Join-Path $App 'index.html') -Raw -Encoding UTF8
$ok = $main.Contains("action === 'suite'") -and $main.Contains('udp_limiter_bench') -and $html.Contains('runMasterLoadSimAction') -and $html.Contains('전체 검사 실행')
Write-Host "version=$ver markers=$ok"
if ($ver -ne $Expected -or -not $ok) { throw "verify failed" }
Write-Host 'OK: 1.0.501 installed' -ForegroundColor Green
return
