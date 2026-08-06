@echo off
chcp 65001 >nul
title Mirae Messenger FORCE UPDATE
echo.
echo ========================================
echo  Mirae Messenger FORCE UPDATE
echo  Target: C:\Apps\...\resources\app
echo ========================================
echo.
echo Works even if the app is frozen.
echo Stops processes, then overwrites from GitHub.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; ^
  $u='https://raw.githubusercontent.com/dragotigree/mirae-messenger/main/scripts/force-update-apps.ps1'; ^
  $o=Join-Path $env:TEMP 'mirae-force-update-apps.ps1'; ^
  $t=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); ^
  Write-Host ('Downloading: '+$u); ^
  Invoke-WebRequest -Uri ($u+'?t='+$t) -OutFile $o -UseBasicParsing; ^
  & $o"
echo.
if errorlevel 1 (
  echo FAILED. Paste this into PowerShell:
  echo.
  echo powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/dragotigree/mirae-messenger/main/scripts/force-update-apps.ps1' -OutFile $env:TEMP\mm-force.ps1 -UseBasicParsing; ^& $env:TEMP\mm-force.ps1"
  echo.
)
pause
