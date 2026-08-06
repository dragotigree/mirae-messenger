# Mirae Messenger - Force update packaged app under C:\Apps
# Downloads by COMMIT SHA (not /main/) to avoid GitHub raw CDN serving stale 477/old files.
# ASCII-only for Windows PowerShell 5.1

param(
  [string]$RepoOwner = 'dragotigree',
  [string]$RepoName = 'mirae-messenger',
  [string]$RepoRef = '',
  [string]$ExpectedVersion = '1.0.479'
)

$ErrorActionPreference = 'Stop'
try { chcp 65001 | Out-Null } catch {}

$PackagedApp = 'C:\Apps\Mirae Messenger\dist\MiraeMessenger-win32-x64\resources\app'
$SourceApp = 'C:\Apps\Mirae Messenger'
$ExePath = 'C:\Apps\Mirae Messenger\dist\MiraeMessenger-win32-x64\MiraeMessenger.exe'
$FallbackRef = '6586d9c19f6f887712f56fad7cf95bb429408182'

$files = @(
  'main.js',
  'preload.js',
  'index.html',
  'package.json',
  'version.json',
  'toast.html',
  'toast-preload.js',
  'lib/minimal-xlsx.js',
  'excalidraw-editor.html',
  'preload-excalidraw.js',
  'lib/excalidraw-app.js',
  'lib/excalidraw-app.css',
  'assets/compact/compact-overlay.css',
  'assets/compact/phosphor-paths.json',
  'assets/splash.png'
)

function Test-AppDir([string]$dir) {
  return ($dir -and (Test-Path -LiteralPath (Join-Path $dir 'index.html')))
}

function Read-Version([string]$dir) {
  try {
    return (Get-Content -LiteralPath (Join-Path $dir 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
  } catch {
    return '?'
  }
}

function Resolve-RepoRef {
  param([string]$Ref)
  if ($Ref -and $Ref.Trim().Length -ge 7) { return $Ref.Trim() }
  try {
    $api = "https://api.github.com/repos/$RepoOwner/$RepoName/commits/main"
    Write-Host ("Resolving latest main commit via API: " + $api) -ForegroundColor DarkGray
    $wc = New-Object System.Net.WebClient
    $wc.Headers['User-Agent'] = 'MiraeMessenger-ForceUpdate'
    $wc.Headers['Cache-Control'] = 'no-cache'
    $json = $wc.DownloadString($api)
    $obj = $json | ConvertFrom-Json
    if ($obj.sha) { return [string]$obj.sha }
  } catch {
    Write-Host ("API resolve failed: " + $_.Exception.Message) -ForegroundColor DarkYellow
  }
  Write-Host ("Using fallback commit: " + $FallbackRef) -ForegroundColor Yellow
  return $FallbackRef
}

function Stop-MessengerHard {
  Write-Host '[1/4] Force-stopping MiraeMessenger / electron...' -ForegroundColor Yellow
  $names = @('MiraeMessenger', 'electron')
  for ($i = 0; $i -lt 3; $i++) {
    $procs = @()
    foreach ($n in $names) {
      $procs += @(Get-Process -Name $n -ErrorAction SilentlyContinue)
    }
    if ($procs.Count -eq 0) { break }
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  Start-Sleep -Seconds 1
}

function Update-AppDir([string]$appDir, [string]$rawBase, $wc, [long]$bust) {
  if (-not (Test-AppDir $appDir)) {
    Write-Host ("  skip (missing): " + $appDir) -ForegroundColor DarkGray
    return $null
  }
  $before = Read-Version $appDir
  Write-Host ("  target: " + $appDir) -ForegroundColor Cyan
  Write-Host ("  before: " + $before)

  $ok = 0
  foreach ($rel in $files) {
    $url = ($rawBase.TrimEnd('/') + '/' + ($rel -replace '\\', '/') + '?t=' + $bust)
    $dst = Join-Path $appDir ($rel -replace '/', '\')
    $dstDir = Split-Path -Parent $dst
    if (-not (Test-Path -LiteralPath $dstDir)) {
      New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
    }
    try {
      Write-Host ("    " + $rel)
      $wc.DownloadFile($url, $dst)
      $ok++
    } catch {
      if ($rel -match 'splash\.png$|compact-overlay\.css$|phosphor-paths\.json$|excalidraw-app\.(js|css)$') {
        Write-Host ("    skip optional: " + $rel) -ForegroundColor DarkGray
        continue
      }
      throw ("download failed: " + $rel + " - " + $_.Exception.Message)
    }
  }
  $after = Read-Version $appDir
  Write-Host ("  done " + $ok + " files -> version " + $after) -ForegroundColor Green
  return $after
}

Write-Host ''
Write-Host '========================================' -ForegroundColor Cyan
Write-Host ' Mirae Messenger FORCE UPDATE (Apps)' -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan
Write-Host ''

$resolvedRef = Resolve-RepoRef -Ref $RepoRef
$RepoRawBase = "https://raw.githubusercontent.com/$RepoOwner/$RepoName/$resolvedRef"
Write-Host ("Commit/ref: " + $resolvedRef)
Write-Host ("Raw base:   " + $RepoRawBase)
Write-Host ("Expected:   " + $ExpectedVersion)
Write-Host ''
Write-Host 'Packaged path (exe reads this):'
Write-Host ("  " + $PackagedApp)
Write-Host ''

if (-not (Test-AppDir $PackagedApp)) {
  Write-Host 'ERROR: packaged app folder not found.' -ForegroundColor Red
  Write-Host ("  expected: " + $PackagedApp + '\index.html')
  exit 1
}

Stop-MessengerHard

Write-Host '[2/4] Downloading by commit SHA (cache-safe)...' -ForegroundColor Yellow
$wc = New-Object System.Net.WebClient
$wc.Headers['User-Agent'] = 'MiraeMessenger-ForceUpdate'
$wc.Headers['Cache-Control'] = 'no-cache'
$wc.CachePolicy = New-Object System.Net.Cache.RequestCachePolicy([System.Net.Cache.RequestCacheLevel]::NoCacheNoStore)
$bust = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

Write-Host '[3/4] Overwriting packaged resources\app ...' -ForegroundColor Yellow
$ver = Update-AppDir -appDir $PackagedApp -rawBase $RepoRawBase -wc $wc -bust $bust
if (-not $ver) { exit 1 }

Write-Host '[3b] Also sync source folder if present...' -ForegroundColor DarkGray
if ((Test-AppDir $SourceApp) -and ($SourceApp -ne $PackagedApp)) {
  try { Update-AppDir -appDir $SourceApp -rawBase $RepoRawBase -wc $wc -bust $bust | Out-Null } catch {
    Write-Host ("  source folder warning: " + $_.Exception.Message) -ForegroundColor DarkYellow
  }
}

Write-Host ''
Write-Host '[4/4] Verify' -ForegroundColor Yellow
$pkgJson = Get-Content -LiteralPath (Join-Path $PackagedApp 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$verJson = Read-Version $PackagedApp
Write-Host ("  package.json = " + $pkgJson.version)
Write-Host ("  version.json = " + $verJson)
Write-Host ("  Expected:     " + $ExpectedVersion)

if ($verJson -ne $ExpectedVersion) {
  Write-Host 'ERROR: version mismatch after download.' -ForegroundColor Red
  Write-Host 'Re-run with explicit ref:' -ForegroundColor Yellow
  Write-Host ("  -RepoRef " + $FallbackRef) -ForegroundColor Yellow
  exit 2
}

Write-Host ''
Write-Host ("FORCE UPDATE OK: " + $verJson) -ForegroundColor Green
Write-Host ("Run ONLY this exe: " + $ExePath) -ForegroundColor Green
Write-Host ''

if (Test-Path -LiteralPath $ExePath) {
  $ans = Read-Host 'Start MiraeMessenger.exe now? (Y/N)'
  if ($ans -match '^[Yy]') {
    Start-Process -FilePath $ExePath
  }
}
