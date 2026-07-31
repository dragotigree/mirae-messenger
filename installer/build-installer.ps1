# Mirae Messenger — 배포용 설치 패키지 생성
# 실행: powershell -ExecutionPolicy Bypass -File .\installer\build-installer.ps1
# OneDrive dist만 쓸 때: -SkipBuild -ExistingAppDir "C:\...\MiraeMessenger-win32-x64"

param(
  [switch]$SkipBuild,
  [string]$ExistingAppDir = '',
  [string]$ReleaseRoot = '',
  [string]$DefaultReleaseParent = ''
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not $ReleaseRoot) {
  if ($DefaultReleaseParent -and (Test-Path -LiteralPath $DefaultReleaseParent)) {
    $ReleaseRoot = Join-Path $DefaultReleaseParent 'Installer'
  } else {
    $ReleaseRoot = Join-Path (Split-Path -Parent $ProjectRoot) 'MiraeMessenger-Installer'
  }
}

Set-Location -LiteralPath $ProjectRoot

$pkg = Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
$packageName = "MiraeMessenger-Setup-v$version-win64"
$stagingDir = Join-Path $ReleaseRoot $packageName
$appDest = Join-Path $stagingDir 'app'
$buildOut = Join-Path $ReleaseRoot '_build'

Write-Host ">> 배포 패키지: $stagingDir"

if ($SkipBuild) {
  if (-not $ExistingAppDir) {
    throw 'SkipBuild 사용 시 -ExistingAppDir 로 MiraeMessenger-win32-x64 경로를 지정하세요.'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $ExistingAppDir 'MiraeMessenger.exe'))) {
    throw "exe 없음: $ExistingAppDir"
  }
  $builtApp = $ExistingAppDir
} else {
  Write-Host '>> sqlite3 재빌드...'
  npx --yes @electron/rebuild -f -w sqlite3

  Write-Host '>> Electron 패키징...'
  New-Item -ItemType Directory -Force -Path $buildOut | Out-Null
  $packager = Join-Path $ProjectRoot 'node_modules\electron-packager\bin\electron-packager.js'
  & node $packager . MiraeMessenger --platform=win32 --arch=x64 --out=$buildOut --overwrite --icon=icon.ico --ignore="/dist|/\.git|/agent-transcripts|/installer|/MiraeMessenger-Installer"
  $builtApp = Join-Path $buildOut 'MiraeMessenger-win32-x64'
  if (-not (Test-Path -LiteralPath $builtApp)) {
    throw '패키징 실패: MiraeMessenger-win32-x64 가 생성되지 않았습니다.'
  }
}

if (Test-Path -LiteralPath $stagingDir) {
  Remove-Item -LiteralPath $stagingDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $appDest | Out-Null

Write-Host ">> app 복사: $builtApp -> $appDest"
Copy-Item -LiteralPath (Join-Path $builtApp '*') -Destination $appDest -Recurse -Force

Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'setup.ps1') -Destination $stagingDir -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README-install.txt') -Destination (Join-Path $stagingDir 'README-install.txt') -Force

$setupCmd = Join-Path $stagingDir 'MiraeMessenger-Setup.cmd'
@'
@echo off
chcp 65001 >nul
title Mirae Messenger Setup
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
if errorlevel 1 pause
'@ | Set-Content -LiteralPath $setupCmd -Encoding ASCII

$zipPath = Join-Path $ReleaseRoot "$packageName.zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -LiteralPath $stagingDir -DestinationPath $zipPath -Force

$rootLauncher = Join-Path $ReleaseRoot 'MiraeMessenger-Setup.cmd'
@"
@echo off
chcp 65001 >nul
cd /d "%~dp0$packageName"
call "%~dp0$packageName\MiraeMessenger-Setup.cmd"
"@ | Set-Content -LiteralPath $rootLauncher -Encoding ASCII

Write-Host ''
Write-Host '완료!' -ForegroundColor Green
Write-Host "  설치 패키지 폴더: $stagingDir"
Write-Host "  ZIP (다른 PC로 전달): $zipPath"
Write-Host "  설치 실행: $setupCmd"
