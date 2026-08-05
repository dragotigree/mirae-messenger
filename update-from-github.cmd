@echo off
cd /d "%~dp0"
echo.
echo Mirae Messenger - GitHub manual update to OneDrive folder
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manual-update-from-github.ps1" -ForceKill -TargetAppDir "%USERPROFILE%\OneDrive\6. Desktop_1\Mirae Messenger"
if errorlevel 1 (
  echo.
  echo Retrying dist\resources\app ...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manual-update-from-github.ps1" -ForceKill -TargetAppDir "%USERPROFILE%\OneDrive\6. Desktop_1\Mirae Messenger\dist\MiraeMessenger-win32-x64\resources\app"
)
echo.
pause
