# Mirae Messenger — GitHub main 최신 파일을 로컬 설치 폴더에 직접 덮어쓰기
# 예:
#   powershell -ExecutionPolicy Bypass -File .\scripts\manual-update-from-github.ps1 -ForceKill
#   powershell -ExecutionPolicy Bypass -File .\scripts\manual-update-from-github.ps1 -ForceKill -TargetAppDir "C:\Users\Owner\OneDrive\6. Desktop_1\Mirae Messenger"

param(
  [string]$TargetAppDir = '',
  [string]$RepoRawBase = 'https://raw.githubusercontent.com/dragotigree/mirae-messenger/main',
  [switch]$ForceKill
)

try {
  chcp 65001 | Out-Null
  [Console]::InputEncoding  = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [Console]::OutputEncoding
} catch {}

$ErrorActionPreference = 'Stop'

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

function Find-DefaultTarget {
  $candidates = @(
    (Join-Path $env:USERPROFILE 'OneDrive\6. Desktop_1\Mirae Messenger\dist\MiraeMessenger-win32-x64\resources\app'),
    (Join-Path $env:USERPROFILE 'OneDrive\6. Desktop_1\Mirae Messenger'),
    (Join-Path $env:LOCALAPPDATA 'MiraeMessenger\resources\app'),
    (Join-Path $env:LOCALAPPDATA 'Programs\MiraeMessenger\resources\app')
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath (Join-Path $c 'index.html'))) { return $c }
  }
  return $null
}

Write-Host ''
Write-Host '=== Mirae Messenger GitHub 수동 업데이트 ===' -ForegroundColor Cyan
Write-Host ''

if (-not $TargetAppDir) {
  Write-Host '설치 폴더 검색 중...' -ForegroundColor DarkGray
  $TargetAppDir = Find-DefaultTarget
}

if (-not $TargetAppDir -or -not (Test-Path -LiteralPath $TargetAppDir)) {
  Write-Host '설치 폴더를 찾지 못했습니다. -TargetAppDir 를 지정하세요.' -ForegroundColor Red
  Write-Host ('  예: -TargetAppDir "' + $env:USERPROFILE + '\OneDrive\6. Desktop_1\Mirae Messenger"') -ForegroundColor Yellow
  exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $TargetAppDir 'index.html'))) {
  $maybeApp = Join-Path $TargetAppDir 'resources\app'
  if (Test-Path -LiteralPath (Join-Path $maybeApp 'index.html')) {
    $TargetAppDir = $maybeApp
  } elseif (Test-Path -LiteralPath (Join-Path $TargetAppDir 'dist\MiraeMessenger-win32-x64\resources\app\index.html')) {
    $TargetAppDir = Join-Path $TargetAppDir 'dist\MiraeMessenger-win32-x64\resources\app'
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $TargetAppDir 'index.html'))) {
  Write-Host "대상에 index.html 이 없습니다: $TargetAppDir" -ForegroundColor Red
  exit 1
}

$dstVer = '?'
try { $dstVer = (Get-Content -LiteralPath (Join-Path $TargetAppDir 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch {}
Write-Host "대상: $TargetAppDir  (현재 $dstVer)"
Write-Host "소스: $RepoRawBase"
Write-Host ''

$procs = @(Get-Process -Name 'MiraeMessenger','electron' -ErrorAction SilentlyContinue)
if ($procs.Count -gt 0) {
  if ($ForceKill) {
    Write-Host "실행 중인 프로세스 $($procs.Count)개 종료 중..." -ForegroundColor Yellow
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  } else {
    Write-Host '메신저가 실행 중입니다. -ForceKill 로 다시 실행하세요.' -ForegroundColor Yellow
    exit 1
  }
}

$wc = New-Object System.Net.WebClient
$wc.Headers['User-Agent'] = 'MiraeMessenger-ManualUpdate'
$wc.CachePolicy = New-Object System.Net.Cache.RequestCachePolicy([System.Net.Cache.RequestCacheLevel]::NoCacheNoStore)
$bust = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$copied = 0
foreach ($rel in $files) {
  $url = ($RepoRawBase.TrimEnd('/') + '/' + ($rel -replace '\\','/') + '?t=' + $bust)
  $dst = Join-Path $TargetAppDir ($rel -replace '/','\')
  $dstDir = Split-Path -Parent $dst
  if (-not (Test-Path -LiteralPath $dstDir)) {
    New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
  }
  try {
    Write-Host "  downloading: $rel"
    $wc.DownloadFile($url, $dst)
    $copied++
  } catch {
    if ($rel -match 'splash\.png$|compact-overlay\.css$|phosphor-paths\.json$|excalidraw-app\.(js|css)$') {
      Write-Host "  skip(optional): $rel" -ForegroundColor DarkGray
      continue
    }
    Write-Host "  FAIL: $rel — $($_.Exception.Message)" -ForegroundColor Red
    exit 1
  }
}

$newVer = '?'
try { $newVer = (Get-Content -LiteralPath (Join-Path $TargetAppDir 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch {}
Write-Host ''
Write-Host "완료 ($copied 개). 대상 버전: $newVer" -ForegroundColor Green
Write-Host '이제 MiraeMessenger.exe 를 다시 실행하세요.' -ForegroundColor Green
