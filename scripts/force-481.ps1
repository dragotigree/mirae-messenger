# Force install Mirae 1.0.481. No prompts. Commit-pinned.
$ErrorActionPreference = 'Stop'
$Ref = '54f34b2851d3a00ddadbbfdab7a05775bf275496'
$Expected = '1.0.481'
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
Write-Host "=== FORCE 1.0.481 (GPU back ON) ===" -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath (Join-Path $App 'index.html'))) { Write-Host "ERROR missing $App" -ForegroundColor Red; exit 1 }
Get-Process -Name 'MiraeMessenger','electron' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$wc = New-Object System.Net.WebClient
$wc.Headers['User-Agent'] = 'MiraeForce481'
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
$main = Get-Content -LiteralPath (Join-Path $App 'main.js') -Raw -Encoding UTF8
$gpuOffDefault = $main.Contains("app.disableHardwareAcceleration();") -and -not $main.Contains("MIRAE_DISABLE_GPU")
$optIn = $main.Contains('MIRAE_DISABLE_GPU')
Write-Host "version=$ver gpuOptInOnly=$optIn"
if ($ver -ne $Expected -or -not $optIn) { Write-Host 'FAIL' -ForegroundColor Red; exit 2 }
Write-Host 'OK: 1.0.481 installed' -ForegroundColor Green
exit 0
