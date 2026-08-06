@echo off
chcp 65001 >nul
title Mirae Messenger FORCE UPDATE 1.0.479
echo.
echo FORCE UPDATE to 1.0.479 (commit-pinned, no CDN cache)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "='Stop'; ^
  ='6586d9c19f6f887712f56fad7cf95bb429408182'; ^
  ='https://raw.githubusercontent.com/dragotigree/mirae-messenger/'++'/scripts/force-update-apps.ps1'; ^
  =Join-Path :TEMP 'mirae-force-update-apps.ps1'; ^
  Write-Host ('Using commit '+); ^
  Invoke-WebRequest -Uri (+'?t='+[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) -OutFile  -UseBasicParsing; ^
  &  -RepoRef  -ExpectedVersion '1.0.479'"
echo.
if errorlevel 1 echo FAILED - version must be 1.0.479
pause
