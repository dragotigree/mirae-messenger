@echo off
chcp 65001 >nul
title Mirae Messenger FORCE UPDATE
echo.
echo ========================================
echo  Mirae Messenger 강제 업데이트
echo  대상: C:\Apps\...\resources\app
echo ========================================
echo.
echo 앱이 멈춰 있어도 됩니다. 프로세스를 종료한 뒤
echo GitHub 최신 파일로 덮어씁니다.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; ^
  $u='https://raw.githubusercontent.com/dragotigree/mirae-messenger/main/scripts/force-update-apps.ps1'; ^
  $o=Join-Path $env:TEMP 'mirae-force-update-apps.ps1'; ^
  $t=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); ^
  Write-Host ('다운로드: '+$u); ^
  Invoke-WebRequest -Uri ($u+'?t='+$t) -OutFile $o -UseBasicParsing; ^
  & $o"
echo.
if errorlevel 1 (
  echo 실패했습니다. 관리자 권한 없이 다시 시도하거나,
  echo 아래를 PowerShell에 붙여 넣으세요.
  echo.
  echo powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/dragotigree/mirae-messenger/main/scripts/force-update-apps.ps1' -OutFile $env:TEMP\mm-force.ps1 -UseBasicParsing; & $env:TEMP\mm-force.ps1"
  echo.
)
pause
