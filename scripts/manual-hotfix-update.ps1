# Mirae Messenger — 앱이 안 열릴 때 수동 핫픽스 (프로그램 UI 업데이트 불가 시)
# 사용법: 트레이·작업 관리자에서 MiraeMessenger를 모두 종료한 뒤, PowerShell에서 실행
#   powershell -ExecutionPolicy Bypass -File ".\scripts\manual-hotfix-update.ps1"
#   powershell -ExecutionPolicy Bypass -File ".\scripts\manual-hotfix-update.ps1" -TargetAppDir "D:\Apps\MiraeMessenger-win32-x64\resources\app"

param(
  [string]$SourceDir = (Split-Path -Parent $PSScriptRoot),
  [string]$TargetAppDir = ''
)

$ErrorActionPreference = 'Stop'

$files = @(
  'main.js',
  'preload.js',
  'index.html',
  'package.json',
  'version.json',
  'assets\splash.png'
)

function Find-DefaultTarget {
  $candidates = @(
    (Join-Path $env:USERPROFILE 'OneDrive\6. Desktop_1\Mirae Messenger\dist\MiraeMessenger-win32-x64\resources\app'),
    (Join-Path $env:USERPROFILE 'MiraeMessenger-dist\MiraeMessenger-win32-x64\resources\app'),
    (Join-Path $env:LOCALAPPDATA 'Programs\MiraeMessenger\resources\app')
  )
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath (Join-Path $c 'index.html')) { return $c }
  }
  return $null
}

if (-not $TargetAppDir) {
  $TargetAppDir = Find-DefaultTarget
}

if (-not $TargetAppDir -or -not (Test-Path -LiteralPath $TargetAppDir)) {
  Write-Host '설치 폴더를 찾지 못했습니다. -TargetAppDir 로 resources\app 경로를 지정해 주세요.' -ForegroundColor Red
  Write-Host '예: ...\MiraeMessenger-win32-x64\resources\app'
  exit 1
}

# TargetAppDir가 exe 루트(win32-x64)로 들어온 경우 resources\app 으로 보정
$indexAtTarget = Join-Path $TargetAppDir 'index.html'
if (-not (Test-Path -LiteralPath $indexAtTarget)) {
  $maybeApp = Join-Path $TargetAppDir 'resources\app'
  if (Test-Path -LiteralPath (Join-Path $maybeApp 'index.html')) {
    $TargetAppDir = $maybeApp
  }
}

Write-Host "원본: $SourceDir"
Write-Host "대상: $TargetAppDir"
Write-Host ''

$procs = Get-Process -Name 'MiraeMessenger','electron' -ErrorAction SilentlyContinue
if ($procs) {
  Write-Host 'MiraeMessenger/electron 프로세스가 아직 실행 중입니다. 작업 관리자에서 모두 종료한 뒤 다시 실행하세요.' -ForegroundColor Yellow
  exit 1
}

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
  Copy-Item -LiteralPath $src -Destination $dst -Force
  Write-Host "  복사: $rel"
}

Write-Host ''
Write-Host '핫픽스 완료. MiraeMessenger.exe 를 다시 실행하세요.' -ForegroundColor Green
