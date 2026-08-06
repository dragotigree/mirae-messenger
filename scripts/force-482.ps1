# Force install Mirae 1.0.482. Includes mobile_server.js. No prompts.
$ErrorActionPreference = 'Stop'
$Ref = '5892953429de35e3467e2f7caa1526a22d8f9743'
$Expected = '1.0.482'
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
Write-Host "=== FORCE 1.0.482 (DB phone_no + mobile_server) ===" -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath (Join-Path $App 'index.html'))) { Write-Host "ERROR missing $App" -ForegroundColor Red; exit 1 }
Get-Process -Name 'MiraeMessenger','electron' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$wc = New-Object System.Net.WebClient
$wc.Headers['User-Agent'] = 'MiraeForce482'
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
$mobile = Test-Path -LiteralPath (Join-Path $App 'mobile_server.js')
$hasMig = $main.Contains("ALTER TABLE known_users ADD COLUMN") -and $main.Contains('phone_no TEXT')
Write-Host "version=$ver mobile_server=$mobile phone_no_migrate=$hasMig"
if ($ver -ne $Expected -or -not $mobile -or -not $hasMig) { Write-Host 'FAIL' -ForegroundColor Red; exit 2 }
Write-Host 'OK: 1.0.482 installed' -ForegroundColor Green
Write-Host 'Also update manual-update / force scripts include mobile_server.js from now on.'
exit 0
