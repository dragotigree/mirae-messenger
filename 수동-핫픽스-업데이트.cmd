@echo off
chcp 65001 >nul
powershell -ExecutionPolicy Bypass -File "%~dp0scripts\manual-hotfix-update.ps1" %*
if errorlevel 1 pause
