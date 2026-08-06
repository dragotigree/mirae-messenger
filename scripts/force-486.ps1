# Force install 1.0.486 = yesterday 471 UI + presence 508-scan OFF (click lag fix).
# No exit — safe with irm|iex.
$ErrorActionPreference = 'Stop'
$Ref = 'cedfc35ad7c0d1ba3882c8cee7d4b306130d3388'
$Expected = '1.0.486'
$App = 'C:\Apps\Mirae Messenger\dist\MiraeMessenger-win32-x64\resources\app'
$Base = "https://raw.githubusercontent.com/dragotigree/mirae-messenger/$Ref"
$Bust = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$files = @(
  'main.js','preload.js','index.html','package.json','version.json',
  'mobile_server.js',
  'toast.html','toast-preload.js','lib/minimal-xlsx.js',
  'excalidraw-editor.html','preload-excalidraw.js'
)
Write-Host "=== FORCE 1.0.486 (471 + presence scan OFF) ===" -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath (Join-Path $App 'index.html'))) {
  Write-Host "ERROR missing $App" -ForegroundColor Red
  throw "missing app folder"
}
Get-Process -Name 'MiraeMessenger','electron' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$wc = New-Object System.Net.WebClient
$wc.Headers['User-Agent'] = 'MiraeForce486'
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
$okScan = $main.Contains('PRESENCE_FULL_SCAN_ENABLED = false')
$okHb = $main.Contains('PRESENCE_HEARTBEAT_MS = 10000')
Write-Host "version=$ver scanOff=$okScan heartbeat10s=$okHb"
if ($ver -ne $Expected -or -not $okScan -or -not $okHb) {
  Write-Host 'FAIL' -ForegroundColor Red
  throw "verify failed"
}
Write-Host 'OK: 1.0.486 installed — click lag fix (no 508 scan)' -ForegroundColor Green
return
