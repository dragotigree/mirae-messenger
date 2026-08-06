@echo off
cd /d "%~dp0"
echo.
echo Mirae Messenger - update packaged app under C:\Apps
echo   (exe reads: dist\MiraeMessenger-win32-x64\resources\app)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manual-update-from-github.ps1" -ForceKill -UpdateAllCopies -TargetAppDir "C:\Apps\Mirae Messenger\dist\MiraeMessenger-win32-x64\resources\app"
echo.
pause
