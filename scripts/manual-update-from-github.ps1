# Mirae Messenger — GitHub main 최신 파일을 로컬 설치 폴더에 직접 덮어쓰기
# 예:
#   powershell -ExecutionPolicy Bypass -File .\scripts\manual-update-from-github.ps1 -ForceKill
#   powershell -ExecutionPolicy Bypass -File .\scripts\manual-update-from-github.ps1 -ForceKill -TargetAppDir "C:\Apps\Mirae Messenger\dist\MiraeMessenger-win32-x64\resources\app"
#
# 주의: MiraeMessenger.exe 는 dist\...\resources\app 의 코드를 읽습니다.
#       상위 소스 폴더(C:\Apps\Mirae Messenger)만 올리면 exe 버전은 그대로입니다.

param(
  [string]$TargetAppDir = '',
  [string]$RepoRawBase = 'https://raw.githubusercontent.com/dragotigree/mirae-messenger/main',
  [switch]$ForceKill,
  [switch]$UpdateAllCopies
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
  'mobile_server.js',
  'toast.html',
  'toast-preload.js',
  'lib/minimal-xlsx.js',
  'excalidraw-editor.html',
  'preload-excalidraw.js',
  'lib/excalidraw-app.js',
  'lib/excalidraw-app.css',
  'assets/compact/compact-overlay.css',
  'assets/compact/phosphor-paths.json',
  'assets/splash.png',
  'assets/fonts/mirae-fonts.css',
  'assets/fonts/Eulyoo1945-Regular.woff2',
  'assets/fonts/Eulyoo1945-SemiBold.woff2',
  'assets/fonts/MaruBuri-Regular.woff2',
  'assets/fonts/MaruBuri-SemiBold.woff2',
  'assets/fonts/Pretendard-Bold.woff2',
  'assets/fonts/Pretendard-Regular.woff2',
  'assets/fonts/RIDIBatang.woff',
  'assets/fonts/SUIT-Bold.woff2',
  'assets/fonts/SUIT-Medium.woff2',
  'assets/fonts/SUIT-Regular.woff2'
)

function Test-AppDir([string]$dir) {
  return ($dir -and (Test-Path -LiteralPath (Join-Path $dir 'index.html')) -and (Test-Path -LiteralPath (Join-Path $dir 'package.json')))
}

# 소스 폴더·exe 폴더·resources\app 어떤 걸 넣어도 실제 코드 폴더로 해석
function Resolve-AppDir([string]$dir) {
  if (-not $dir) { return $null }
  $dir = $dir.TrimEnd('\', '/')

  $packagedUnder = Join-Path $dir 'dist\MiraeMessenger-win32-x64\resources\app'
  if (Test-AppDir $packagedUnder) { return $packagedUnder }

  $asResources = Join-Path $dir 'resources\app'
  if (Test-AppDir $asResources) { return $asResources }

  $nested = Join-Path $dir 'MiraeMessenger-win32-x64\resources\app'
  if (Test-AppDir $nested) { return $nested }

  if (Test-AppDir $dir) { return $dir }
  return $null
}

function Find-DefaultTargets {
  $ordered = @(
    'C:\Apps\Mirae Messenger\dist\MiraeMessenger-win32-x64\resources\app',
    'C:\Apps\Mirae Messenger\resources\app',
    (Join-Path $env:USERPROFILE 'OneDrive\6. Desktop_1\Mirae Messenger\dist\MiraeMessenger-win32-x64\resources\app'),
    (Join-Path $env:LOCALAPPDATA 'MiraeMessenger\resources\app'),
    (Join-Path $env:LOCALAPPDATA 'Programs\MiraeMessenger\resources\app'),
    'C:\Apps\Mirae Messenger',
    (Join-Path $env:USERPROFILE 'OneDrive\6. Desktop_1\Mirae Messenger')
  )
  $found = @()
  foreach ($c in $ordered) {
    $resolved = Resolve-AppDir $c
    if ($resolved -and ($found -notcontains $resolved)) { $found += $resolved }
  }
  return $found
}

function Get-RelatedAppDirs([string]$primary) {
  $out = @($primary)
  # Apps 루트에 소스 복사본과 dist 패키지가 둘 다 있으면 같이 맞춤
  $appsRoot = 'C:\Apps\Mirae Messenger'
  $candidates = @(
    (Join-Path $appsRoot 'dist\MiraeMessenger-win32-x64\resources\app'),
    $appsRoot
  )
  foreach ($c in $candidates) {
    $r = Resolve-AppDir $c
    if ($r -and ($out -notcontains $r)) { $out += $r }
  }
  return $out
}

function Update-OneAppDir([string]$appDir, [string]$repoBase, [long]$bust, $wc) {
  $dstVer = '?'
  try { $dstVer = (Get-Content -LiteralPath (Join-Path $appDir 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch {}
  Write-Host "대상: $appDir  (현재 $dstVer)" -ForegroundColor Cyan

  $copied = 0
  foreach ($rel in $files) {
    $url = ($repoBase.TrimEnd('/') + '/' + ($rel -replace '\\','/') + '?t=' + $bust)
    $dst = Join-Path $appDir ($rel -replace '/','\')
    $dstDir = Split-Path -Parent $dst
    if (-not (Test-Path -LiteralPath $dstDir)) {
      New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
    }
    try {
      Write-Host "  downloading: $rel"
      $wc.DownloadFile($url, $dst)
      $copied++
    } catch {
      if ($rel -match 'splash\.png$|compact-overlay\.css$|phosphor-paths\.json$|excalidraw-app\.(js|css)$|assets/fonts/') {
        Write-Host "  skip(optional): $rel" -ForegroundColor DarkGray
        continue
      }
      Write-Host "  FAIL: $rel — $($_.Exception.Message)" -ForegroundColor Red
      throw
    }
  }

  $newVer = '?'
  try { $newVer = (Get-Content -LiteralPath (Join-Path $appDir 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch {}
  Write-Host "  → 완료 ($copied 개). 버전: $newVer" -ForegroundColor Green
  return $newVer
}

Write-Host ''
Write-Host '=== Mirae Messenger GitHub 수동 업데이트 ===' -ForegroundColor Cyan
Write-Host ''

$targets = @()
if ($TargetAppDir) {
  $resolved = Resolve-AppDir $TargetAppDir
  if (-not $resolved) {
    Write-Host "대상에 index.html 이 없습니다: $TargetAppDir" -ForegroundColor Red
    Write-Host '  exe 실행본은 보통 여기입니다:' -ForegroundColor Yellow
    Write-Host '  C:\Apps\Mirae Messenger\dist\MiraeMessenger-win32-x64\resources\app' -ForegroundColor Yellow
    exit 1
  }
  if ($UpdateAllCopies -or ($TargetAppDir -match '(?i)[\\/]Apps[\\/]Mirae Messenger')) {
    $targets = @(Get-RelatedAppDirs $resolved)
  } else {
    $targets = @($resolved)
  }
} else {
  Write-Host '설치 폴더 검색 중... (패키지 resources\app 우선)' -ForegroundColor DarkGray
  $targets = @(Find-DefaultTargets)
  if (-not $targets -or $targets.Count -eq 0) {
    Write-Host '설치 폴더를 찾지 못했습니다. -TargetAppDir 를 지정하세요.' -ForegroundColor Red
    Write-Host '  예: -TargetAppDir "C:\Apps\Mirae Messenger\dist\MiraeMessenger-win32-x64\resources\app"' -ForegroundColor Yellow
    exit 1
  }
  # 기본 검색 시 패키지 경로 1곳만 (Apps 루트면 관련 사본도)
  if ($targets[0] -match '(?i)[\\/]Apps[\\/]Mirae Messenger') {
    $targets = @(Get-RelatedAppDirs $targets[0])
  } else {
    $targets = @($targets[0])
  }
}

Write-Host "소스: $RepoRawBase"
Write-Host ("업데이트 대상 " + $targets.Count + "곳:")
$targets | ForEach-Object { Write-Host "  - $_" }
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
$lastVer = '?'

foreach ($dir in $targets) {
  Write-Host ''
  $lastVer = Update-OneAppDir -appDir $dir -repoBase $RepoRawBase -bust $bust -wc $wc
}

Write-Host ''
Write-Host "전체 완료. 마지막 적용 버전: $lastVer" -ForegroundColor Green
Write-Host 'MiraeMessenger.exe 는 dist\MiraeMessenger-win32-x64\ 에서 다시 실행하세요.' -ForegroundColor Green
Write-Host '확인: dist\...\resources\app\version.json' -ForegroundColor DarkGray
