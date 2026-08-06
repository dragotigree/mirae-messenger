# Force 1.0.487 — local userdata + no Z auto-update hang. No exit (irm|iex safe).
$ErrorActionPreference = 'Stop'
$Ref = 'PLACEHOLDER_COMMIT'
$Expected = '1.0.487'
$App = 'C:\Apps\Mirae Messenger\dist\MiraeMessenger-win32-x64\resources\app'
$Base = "https://raw.githubusercontent.com/dragotigree/mirae-messenger/$Ref"
$Bust = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$files = @(
  'main.js','preload.js','index.html','package.json','version.json',
  'mobile_server.js',
  'toast.html','toast-preload.js','lib/minimal-xlsx.js',
  'excalidraw-editor.html','preload-excalidraw.js'
)
Write-Host "=== FORCE 1.0.487 (local userdata / freeze fix) ===" -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath (Join-Path $App 'index.html'))) {
  Write-Host "ERROR missing $App" -ForegroundColor Red
  throw "missing app folder"
}
Get-Process -Name 'MiraeMessenger','electron' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$wc = New-Object System.Net.WebClient
$wc.Headers['User-Agent'] = 'MiraeForce487'
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
$ok = $main.Contains('ensureAppsLocalUserData') -and $main.Contains('C:\\Apps\\Mirae Messenger\\userdata')
Write-Host "version=$ver localUserData=$ok"
Write-Host "APPDATA=$env:APPDATA"
if ($ver -ne $Expected -or -not $ok) {
  Write-Host 'FAIL' -ForegroundColor Red
  throw "verify failed"
}
Write-Host 'OK: 1.0.487 installed' -ForegroundColor Green
Write-Host 'Data folder: C:\Apps\Mirae Messenger\userdata'
return
