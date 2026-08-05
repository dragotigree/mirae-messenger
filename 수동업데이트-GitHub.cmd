@echo off
REM Download latest files from GitHub into OneDrive / local install folder
cd /d "%~dp0"
echo.
echo Mirae Messenger — GitHub 최신 수동 업데이트
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manual-update-from-github.ps1" -ForceKill -TargetAppDir "%USERPROFILE%\OneDrive\6. Desktop_1\Mirae Messenger"
if errorlevel 1 (
  echo.
  echo dist\resources\app 경로로 재시도합니다...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manual-update-from-github.ps1" -ForceKill -TargetAppDir "%USERPROFILE%\OneDrive\6. Desktop_1\Mirae Messenger\dist\MiraeMessenger-win32-x64\resources\app"
)
echo.
pause
