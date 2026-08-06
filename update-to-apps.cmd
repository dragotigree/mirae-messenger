@echo off
cd /d "%~dp0"
echo.
echo Mirae Messenger - update C:\Apps\Mirae Messenger from GitHub
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manual-update-from-github.ps1" -ForceKill -TargetAppDir "C:\Apps\Mirae Messenger"
if errorlevel 1 (
  echo.
  echo Retrying resources\app ...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manual-update-from-github.ps1" -ForceKill -TargetAppDir "C:\Apps\Mirae Messenger\resources\app"
)
if errorlevel 1 (
  echo.
  echo Retrying dist\resources\app ...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manual-update-from-github.ps1" -ForceKill -TargetAppDir "C:\Apps\Mirae Messenger\dist\MiraeMessenger-win32-x64\resources\app"
)
echo.
pause
