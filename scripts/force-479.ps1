# Force install Mirae 1.0.479 into packaged app. No prompts. Commit-pinned.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\force-479.ps1

$ErrorActionPreference = 'Stop'
$Ref = '6586d9c19f6f887712f56fad7cf95bb429408182'
$Expected = '1.0.479'
$App = 'C:\Apps\Mirae Messenger\dist\MiraeMessenger-win32-x64\resources\app'
$Base = "https://raw.githubusercontent.com/dragotigree/mirae-messenger/$Ref"
$Bust = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

$files = @(
  'main.js','preload.js','index.html','package.json','version.json',
  'toast.html','toast-preload.js','lib/minimal-xlsx.js',
  'excalidraw-editor.html','preload-excalidraw.js',
  'lib/excalidraw-app.js','lib/excalidraw-app.css',
  'assets/compact/compact-overlay.css','assets/compact/phosphor-paths.json','assets/splash.png'
)

Write-Host "=== FORCE 1.0.479 (no prompt) ===" -ForegroundColor Cyan
Write-Host "Ref: $Ref"
Write-Host "App: $App"

if (-not (Test-Path -LiteralPath (Join-Path $App 'index.html'))) {
  Write-Host "ERROR: app folder missing: $App" -ForegroundColor Red
  exit 1
}

Write-Host 'Stopping MiraeMessenger/electron...' -ForegroundColor Yellow
Get-Process -Name 'MiraeMessenger','electron' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$wc = New-Object System.Net.WebClient
$wc.Headers['User-Agent'] = 'MiraeForce479'
$wc.Headers['Cache-Control'] = 'no-cache'
$wc.CachePolicy = New-Object System.Net.Cache.RequestCachePolicy([System.Net.Cache.RequestCacheLevel]::NoCacheNoStore)

foreach ($rel in $files) {
  $url = "$Base/$($rel -replace '\\','/')?t=$Bust"
  $dst = Join-Path $App ($rel -replace '/','\')
  $dir = Split-Path -Parent $dst
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  try {
    Write-Host "  $rel"
    $wc.DownloadFile($url, $dst)
  } catch {
    if ($rel -match 'splash\.png$|compact-overlay|phosphor-paths|excalidraw-app') {
      Write-Host "  skip optional $rel" -ForegroundColor DarkGray
      continue
    }
    throw
  }
}

$ver = (Get-Content -LiteralPath (Join-Path $App 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$pkg = (Get-Content -LiteralPath (Join-Path $App 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$main = Get-Content -LiteralPath (Join-Path $App 'main.js') -Raw -Encoding UTF8
$hasFlag = $main.Contains('PRESENCE_FULL_SCAN_ENABLED')
$hasGpu = $main.Contains('disableHardwareAcceleration')

Write-Host ''
Write-Host "version.json = $ver"
Write-Host "package.json = $pkg"
Write-Host "PRESENCE_FULL_SCAN_ENABLED present = $hasFlag"
Write-Host "disableHardwareAcceleration present = $hasGpu"

if ($ver -ne $Expected -or $pkg -ne $Expected -or -not $hasFlag) {
  Write-Host 'FAIL: 1.0.479 not installed correctly' -ForegroundColor Red
  exit 2
}

Write-Host 'OK: 1.0.479 installed. Run MiraeMessenger.exe' -ForegroundColor Green
exit 0
