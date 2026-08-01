@echo off
REM Same as ??????.cmd ? English filename for safer double-click
cd /d "%~dp0"
echo.
echo Mirae Messenger manual update
echo Closing app if running, then copying latest files...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manual-hotfix-update.ps1" -ForceKill
echo.
pause
