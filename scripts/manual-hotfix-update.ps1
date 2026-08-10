# Mirae Messenger — 앱이 안 열릴 때 / 업데이트가 멈췄을 때 수동 핫픽스
# 사용법 (메신저 종료 후):
#   powershell -ExecutionPolicy Bypass -File "Z:\9.재활치료실(PT&OT&언어&임상심리)\물리치료실\messenger\scripts\manual-hotfix-update.ps1"
#   powershell -ExecutionPolicy Bypass -File "...\manual-hotfix-update.ps1" -ForceKill
#   powershell -ExecutionPolicy Bypass -File "...\manual-hotfix-update.ps1" -TargetAppDir "C:\...\resources\app"
# NOTE: param() must be first statement (comments/#Requires only above it).

param(
  [string]$SourceDir = (Split-Path -Parent $PSScriptRoot),
  [string]$TargetAppDir = '',
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
  'lib\minimal-xlsx.js',
  'assets\splash.png',
  'assets\fonts\mirae-fonts.css',
  'assets\fonts\Eulyoo1945-Regular.woff2',
  'assets\fonts\Eulyoo1945-SemiBold.woff2',
  'assets\fonts\MaruBuri-Regular.woff2',
  'assets\fonts\MaruBuri-SemiBold.woff2',
  'assets\fonts\Pretendard-Bold.woff2',
  'assets\fonts\Pretendard-Regular.woff2',
  'assets\fonts\RIDIBatang.woff',
  'assets\fonts\SUIT-Bold.woff2',
  'assets\fonts\SUIT-Medium.woff2',
  'assets\fonts\SUIT-Regular.woff2'
)

function Find-AppDirFromExe([string]$exePath) {
  if (-not $exePath) { return $null }
  try {
    $root = Split-Path -Parent $exePath
    $app = Join-Path $root 'resources\app'
    if (Test-Path -LiteralPath (Join-Path $app 'index.html')) { return $app }
  } catch {}
  return $null
}

function Find-DefaultTarget {
  $candidates = @(
    # 설치 프로그램 기본 경로
    (Join-Path $env:LOCALAPPDATA 'MiraeMessenger\resources\app'),
    (Join-Path $env:LOCALAPPDATA 'Programs\MiraeMessenger\resources\app'),
    # 개발/수동 배포 경로
    (Join-Path $env:USERPROFILE 'OneDrive\6. Desktop_1\Mirae Messenger\dist\MiraeMessenger-win32-x64\resources\app'),
    (Join-Path $env:USERPROFILE 'Desktop\Mirae Messenger\dist\MiraeMessenger-win32-x64\resources\app'),
    (Join-Path $env:USERPROFILE 'Desktop\MiraeMessenger-win32-x64\resources\app'),
    (Join-Path $env:USERPROFILE 'MiraeMessenger-dist\MiraeMessenger-win32-x64\resources\app'),
    (Join-Path $env:USERPROFILE 'MiraeMessenger\resources\app'),
    'C:\MiraeMessenger\resources\app',
    'D:\MiraeMessenger\resources\app'
  )

  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath (Join-Path $c 'index.html'))) { return $c }
  }

  # 실행 중인/최근 프로세스 경로에서 추정
  $procs = Get-Process -Name 'MiraeMessenger' -ErrorAction SilentlyContinue
  foreach ($p in @($procs)) {
    $found = Find-AppDirFromExe $p.Path
    if ($found) { return $found }
  }

  # 시작메뉴 바로가기에서 추정
  $lnkRoots = @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
  )
  foreach ($root in $lnkRoots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    Get-ChildItem -LiteralPath $root -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '메신저|Mirae|mirae' } |
      ForEach-Object {
        try {
          $sh = New-Object -ComObject WScript.Shell
          $target = $sh.CreateShortcut($_.FullName).TargetPath
          $found = Find-AppDirFromExe $target
          if ($found) { return $found }
        } catch {}
      }
  }

  # 넓은 검색 (느릴 수 있음) — LocalAppData 아래 MiraeMessenger.exe
  try {
    $exe = Get-ChildItem -LiteralPath $env:LOCALAPPDATA -Recurse -Filter 'MiraeMessenger.exe' -ErrorAction SilentlyContinue |
      Select-Object -First 3
    foreach ($e in @($exe)) {
      $found = Find-AppDirFromExe $e.FullName
      if ($found) { return $found }
    }
  } catch {}

  return $null
}

Write-Host ''
Write-Host '=== Mirae Messenger 수동 핫픽스 ===' -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path -LiteralPath (Join-Path $SourceDir 'index.html'))) {
  Write-Host "원본(소스) 폴더가 올바르지 않습니다: $SourceDir" -ForegroundColor Red
  Write-Host 'Z 드라이브 messenger 폴더에서 스크립트를 실행했는지 확인해 주세요.' -ForegroundColor Yellow
  exit 1
}

if (-not $TargetAppDir) {
  Write-Host '설치 폴더 검색 중...' -ForegroundColor DarkGray
  $TargetAppDir = Find-DefaultTarget
}

if (-not $TargetAppDir -or -not (Test-Path -LiteralPath $TargetAppDir)) {
  Write-Host '설치 폴더를 찾지 못했습니다.' -ForegroundColor Red
  Write-Host ''
  Write-Host '작업 관리자에서 MiraeMessenger 우클릭 → "파일 위치 열기" 후,' -ForegroundColor Yellow
  Write-Host '그 폴더 안의 resources\app 경로를 -TargetAppDir 로 지정하세요.' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '예:' -ForegroundColor Yellow
  Write-Host ('  powershell -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -ForceKill -TargetAppDir "' + $env:LOCALAPPDATA + '\MiraeMessenger\resources\app"')
  exit 1
}

# TargetAppDir가 exe 루트(win32-x64 / MiraeMessenger)로 들어온 경우 resources\app 으로 보정
$indexAtTarget = Join-Path $TargetAppDir 'index.html'
if (-not (Test-Path -LiteralPath $indexAtTarget)) {
  $maybeApp = Join-Path $TargetAppDir 'resources\app'
  if (Test-Path -LiteralPath (Join-Path $maybeApp 'index.html')) {
    $TargetAppDir = $maybeApp
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $TargetAppDir 'index.html'))) {
  Write-Host "대상 폴더에 index.html 이 없습니다: $TargetAppDir" -ForegroundColor Red
  exit 1
}

$srcVer = '?'
$dstVer = '?'
try { $srcVer = (Get-Content -LiteralPath (Join-Path $SourceDir 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch {}
try { $dstVer = (Get-Content -LiteralPath (Join-Path $TargetAppDir 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch {}

Write-Host "원본: $SourceDir  (버전 $srcVer)"
Write-Host "대상: $TargetAppDir  (현재 $dstVer)"
Write-Host ''

$procs = @(Get-Process -Name 'MiraeMessenger','electron' -ErrorAction SilentlyContinue)
if ($procs.Count -gt 0) {
  if ($ForceKill) {
    Write-Host "실행 중인 프로세스 $($procs.Count)개 종료 중..." -ForegroundColor Yellow
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    $left = @(Get-Process -Name 'MiraeMessenger','electron' -ErrorAction SilentlyContinue)
    if ($left.Count -gt 0) {
      Write-Host '프로세스가 아직 남아 있습니다. 작업 관리자에서 강제 종료 후 다시 실행하세요.' -ForegroundColor Red
      exit 1
    }
  } else {
    Write-Host 'MiraeMessenger/electron 이 아직 실행 중입니다.' -ForegroundColor Yellow
    Write-Host '트레이에서 완전히 종료하거나, -ForceKill 옵션으로 다시 실행하세요.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host ('  powershell -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -ForceKill') -ForegroundColor Cyan
    exit 1
  }
}

$copied = 0
foreach ($rel in $files) {
  $src = Join-Path $SourceDir $rel
  $dst = Join-Path $TargetAppDir $rel
  if (-not (Test-Path -LiteralPath $src)) {
    Write-Host "  건너뜀 (원본 없음): $rel"
    continue
  }
  $dstDir = Split-Path -Parent $dst
  if (-not (Test-Path -LiteralPath $dstDir)) {
    New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
  }
  try {
    Copy-Item -LiteralPath $src -Destination $dst -Force
    Write-Host "  복사: $rel"
    $copied++
  } catch {
    Write-Host "  실패: $rel — $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '  (파일이 사용 중이면 메신저를 모두 종료한 뒤 -ForceKill 로 다시 시도)' -ForegroundColor Yellow
    exit 1
  }
}

$newVer = '?'
try { $newVer = (Get-Content -LiteralPath (Join-Path $TargetAppDir 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch {}

Write-Host ''
Write-Host "핫픽스 완료 ($copied 개 파일). 대상 버전: $newVer" -ForegroundColor Green
Write-Host '이제 MiraeMessenger.exe 를 다시 실행하세요.' -ForegroundColor Green

# exe 경로 안내
$exeGuess = Join-Path (Split-Path -Parent (Split-Path -Parent $TargetAppDir)) 'MiraeMessenger.exe'
if (Test-Path -LiteralPath $exeGuess) {
  Write-Host ''
  Write-Host "실행 파일: $exeGuess" -ForegroundColor DarkGray
}
