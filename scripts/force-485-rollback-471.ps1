# Force rollback to yesterday-evening stable (1.0.471 code) as 1.0.485.
# Target: packaged exe resources\app only. No prompts.
$ErrorActionPreference = 'Stop'
$Ref = 'PLACEHOLDER_COMMIT'
$Expected = '1.0.485'
$App = 'C:\Apps\Mirae Messenger\dist\MiraeMessenger-win32-x64\resources\app'
$Base = "https://raw.githubusercontent.com/dragotigree/mirae-messenger/$Ref"
$Bust = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$files = @(
  'main.js','preload.js','index.html','package.json','version.json',
  'mobile_server.js',
  'toast.html','toast-preload.js','lib/minimal-xlsx.js',
  'excalidraw-editor.html','preload-excalidraw.js',
  'lib/excalidraw-app.js','lib/excalidraw-app.css',
  'assets/compact/compact-overlay.css','assets/compact/phosphor-paths.json','assets/splash.png'
)
Write-Host "=== FORCE ROLLBACK 1.0.485 (= 1.0.471 yesterday evening) ===" -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath (Join-Path $App 'index.html'))) { Write-Host "ERROR missing $App" -ForegroundColor Red; exit 1 }
Get-Process -Name 'MiraeMessenger','electron' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$wc = New-Object System.Net.WebClient
$wc.Headers['User-Agent'] = 'MiraeForce485Rollback'
$wc.Headers['Cache-Control'] = 'no-cache'
$wc.CachePolicy = New-Object System.Net.Cache.RequestCachePolicy([System.Net.Cache.RequestCacheLevel]::NoCacheNoStore)
foreach ($rel in $files) {
  $url = "$Base/$($rel -replace '\\','/')?t=$Bust"
  $dst = Join-Path $App ($rel -replace '/','\')
  $dir = Split-Path -Parent $dst
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  try { Write-Host "  $rel"; $wc.DownloadFile($url, $dst) }
  catch {
    if ($rel -match 'splash\.png$|compact-overlay|phosphor-paths|excalidraw-app') { continue }
    throw
  }
}
$ver = (Get-Content -LiteralPath (Join-Path $App 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$pkg = (Get-Content -LiteralPath (Join-Path $App 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$main = Get-Content -LiteralPath (Join-Path $App 'main.js') -Raw -Encoding UTF8
# 471 markers: no UDP_RX storm shield (480+), no CalculateNativeWinOcclusion (484)
$is471Lineage = -not $main.Contains('UDP_RX_MAX_PER_SEC') -and -not $main.Contains('CalculateNativeWinOcclusion')
Write-Host "version.json=$ver package.json=$pkg lineage471=$is471Lineage"
if ($ver -ne $Expected -or $pkg -ne $Expected -or -not $is471Lineage) { Write-Host 'FAIL' -ForegroundColor Red; exit 2 }
Write-Host 'OK: 1.0.485 installed (yesterday evening 1.0.471 code)' -ForegroundColor Green
Write-Host 'Run: C:\Apps\Mirae Messenger\dist\MiraeMessenger-win32-x64\MiraeMessenger.exe'
exit 0
