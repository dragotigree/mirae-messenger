@echo off
chcp 65001 >nul
title Mirae Messenger FORCE UPDATE
echo.
echo ========================================
echo  Mirae Messenger FORCE UPDATE
echo  Uses commit SHA (avoids GitHub CDN cache)
echo ========================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; ^
  $ref='c61c87fa60eec01bdd7f82ab67a9c6d2737dc267'; ^
  $u='https://raw.githubusercontent.com/dragotigree/mirae-messenger/'+$ref+'/scripts/force-update-apps.ps1'; ^
  $o=Join-Path $env:TEMP 'mirae-force-update-apps.ps1'; ^
  Write-Host ('Downloading script from commit '+$ref); ^
  Invoke-WebRequest -Uri ($u+'?t='+[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) -OutFile $o -UseBasicParsing; ^
  & $o -RepoRef $ref -ExpectedVersion '1.0.478'"
echo.
if errorlevel 1 (
  echo FAILED. Try this in PowerShell:
  echo powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/dragotigree/mirae-messenger/c61c87fa60eec01bdd7f82ab67a9c6d2737dc267/scripts/force-update-apps.ps1' -OutFile $env:TEMP\mm-force.ps1 -UseBasicParsing; & $env:TEMP\mm-force.ps1 -RepoRef c61c87fa60eec01bdd7f82ab67a9c6d2737dc267 -ExpectedVersion 1.0.478"
)
pause
