# Mirae Messenger — PC 설치 (사용자별, 관리자 권한 불필요)
param(
  [string]$SourceAppDir = (Join-Path $PSScriptRoot 'app'),
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'MiraeMessenger'),
  [switch]$Silent
)

$ErrorActionPreference = 'Stop'
$AppExeName = 'MiraeMessenger.exe'
$ProductName = '미래병원 메신저'
$DesktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) "$ProductName.lnk"
$StartMenuDir = Join-Path ([Environment]::GetFolderPath('Programs')) $ProductName
$StartMenuLink = Join-Path $StartMenuDir "$ProductName.lnk"
$UninstallScript = Join-Path $InstallDir 'uninstall.ps1'
$VersionFile = Join-Path $SourceAppDir 'resources\app\version.json'

function Write-Step([string]$msg) {
  if (-not $Silent) { Write-Host $msg -ForegroundColor Cyan }
}

if (-not (Test-Path -LiteralPath (Join-Path $SourceAppDir $AppExeName))) {
  Write-Host "설치 파일을 찾을 수 없습니다. 'app' 폴더에 MiraeMessenger.exe 가 있는지 확인해 주세요." -ForegroundColor Red
  exit 1
}

$running = Get-Process -Name 'MiraeMessenger' -ErrorAction SilentlyContinue
if ($running) {
  Write-Host 'MiraeMessenger가 실행 중입니다. 종료한 뒤 다시 설치해 주세요.' -ForegroundColor Yellow
  exit 1
}

$version = 'unknown'
if (Test-Path -LiteralPath $VersionFile) {
  try {
    $version = (Get-Content -LiteralPath $VersionFile -Raw | ConvertFrom-Json).version
  } catch { }
}

Write-Step "버전 $version 설치 중..."
Write-Step "설치 위치: $InstallDir"

if (Test-Path -LiteralPath $InstallDir) {
  if (-not $Silent) {
    $ans = Read-Host '기존 설치가 있습니다. 덮어쓰시겠습니까? (Y/N)'
    if ($ans -notmatch '^[Yy]') { Write-Host '설치를 취소했습니다.'; exit 0 }
  }
  Remove-Item -LiteralPath $InstallDir -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -LiteralPath (Join-Path $SourceAppDir '*') -Destination $InstallDir -Recurse -Force

$Wsh = New-Object -ComObject WScript.Shell
$exePath = Join-Path $InstallDir $AppExeName

New-Item -ItemType Directory -Force -Path $StartMenuDir | Out-Null
foreach ($link in @($DesktopLink, $StartMenuLink)) {
  $sc = $Wsh.CreateShortcut($link)
  $sc.TargetPath = $exePath
  $sc.WorkingDirectory = $InstallDir
  $sc.Description = $ProductName
  $sc.Save()
}

@'
param([switch]$Silent)
$ErrorActionPreference = 'Stop'
$ProductName = '미래병원 메신저'
$InstallDir = Join-Path $env:LOCALAPPDATA 'MiraeMessenger'
Get-Process -Name 'MiraeMessenger' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$DesktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) "$ProductName.lnk"
$StartMenuLink = Join-Path ([Environment]::GetFolderPath('Programs')) "$ProductName\$ProductName.lnk"
foreach ($p in @($DesktopLink, $StartMenuLink)) {
  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
}
$smDir = Split-Path -Parent $StartMenuLink
if (Test-Path -LiteralPath $smDir) { Remove-Item -LiteralPath $smDir -Recurse -Force -ErrorAction SilentlyContinue }
if (Test-Path -LiteralPath $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
if (-not $Silent) { Write-Host '제거가 완료되었습니다.' -ForegroundColor Green }
'@ | Set-Content -LiteralPath $UninstallScript -Encoding UTF8

$uninstallBat = Join-Path $InstallDir '제거.bat'
Set-Content -LiteralPath $uninstallBat -Encoding ASCII -Value "@echo off`r`npowershell -ExecutionPolicy Bypass -File `"$UninstallScript`" -Silent`r`npause"

if (-not $Silent) {
  Write-Host ''
  Write-Host '설치가 완료되었습니다.' -ForegroundColor Green
  Write-Host "  실행: 바탕화면 「$ProductName」 또는 $exePath"
  Write-Host "  제거: $uninstallBat"
  $run = Read-Host '지금 실행하시겠습니까? (Y/N)'
  if ($run -match '^[Yy]') { Start-Process -LiteralPath $exePath }
}
