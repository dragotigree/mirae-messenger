# Force 1.0.489 — TCP listen deferred 45s. No exit.
$ErrorActionPreference = 'Stop'
$Ref = 'PLACEHOLDER_COMMIT'
$Expected = '1.0.489'
$App = 'C:\Apps\Mirae Messenger\dist\MiraeMessenger-win32-x64\resources\app'
$Base = "https://raw.githubusercontent.com/dragotigree/mirae-messenger/$Ref"
$Bust = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$files = @(
  'main.js','preload.js','index.html','package.json','version.json',
  'mobile_server.js','toast.html','toast-preload.js','lib/minimal-xlsx.js',
  'excalidraw-editor.html','preload-excalidraw.js'
)
Write-Host "=== FORCE 1.0.489 (TCP deferred 45s) ===" -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath (Join-Path $App 'index.html'))) { throw "missing $App" }
Get-Process -Name 'MiraeMessenger','electron' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$wc = New-Object System.Net.WebClient
$wc.Headers['User-Agent'] = 'MiraeForce489'
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
$ok = $main.Contains('TCP deferred') -and $main.Contains('[TCP] 버퍼 초과')
Write-Host "version=$ver tcpDefer=$ok"
if ($ver -ne $Expected -or -not $ok) { throw "verify failed" }
Write-Host 'OK: 1.0.489 installed' -ForegroundColor Green
Write-Host 'Also kill any load-test scripts still running on this PC.' -ForegroundColor Yellow
return
