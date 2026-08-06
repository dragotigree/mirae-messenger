@echo off
chcp 65001 >nul
title Mirae Messenger FORCE UPDATE
echo.
echo ========================================
echo  Mirae Messenger FORCE UPDATE
echo  Commit-pinned (avoids GitHub CDN cache)
echo ========================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; ^
  $scriptRef='693d61ab84c721b92a458934b791b0f0eb2662db'; ^
  $appRef='c61c87fa60eec01bdd7f82ab67a9c6d2737dc267'; ^
  $u='https://raw.githubusercontent.com/dragotigree/mirae-messenger/'+$scriptRef+'/scripts/force-update-apps.ps1'; ^
  $o=Join-Path $env:TEMP 'mirae-force-update-apps.ps1'; ^
  Write-Host ('Script: '+$scriptRef); ^
  Write-Host ('App:    '+$appRef+' (1.0.478)'); ^
  Invoke-WebRequest -Uri ($u+'?t='+[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) -OutFile $o -UseBasicParsing; ^
  & $o -RepoRef $appRef -ExpectedVersion '1.0.478'"
echo.
if errorlevel 1 (
  echo FAILED.
)
pause
