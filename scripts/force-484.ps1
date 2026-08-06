# Force install Mirae 1.0.484. Occlusion off + no backdrop blur. No prompts.
$ErrorActionPreference = 'Stop'
$Ref = 'PLACEHOLDER_COMMIT'
$Expected = '1.0.484'
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
Write-Host "=== FORCE 1.0.484 (occlusion + blur CPU) ===" -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath (Join-Path $App 'index.html'))) { Write-Host "ERROR missing $App" -ForegroundColor Red; exit 1 }
Get-Process -Name 'MiraeMessenger','electron' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$wc = New-Object System.Net.WebClient
$wc.Headers['User-Agent'] = 'MiraeForce484'
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
$idx = Get-Content -LiteralPath (Join-Path $App 'index.html') -Raw -Encoding UTF8
$mobile = Test-Path -LiteralPath (Join-Path $App 'mobile_server.js')
$hasOcc = $main.Contains('CalculateNativeWinOcclusion')
$noBlur = -not ($idx -match 'backdrop-filter:\s*blur')
Write-Host "version=$ver mobile=$mobile occlusionOff=$hasOcc noBlur=$noBlur"
if ($ver -ne $Expected -or -not $mobile -or -not $hasOcc -or -not $noBlur) { Write-Host 'FAIL' -ForegroundColor Red; exit 2 }
Write-Host 'OK: 1.0.484 installed' -ForegroundColor Green
exit 0
