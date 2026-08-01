@echo off
chcp 65001 >nul
title Mirae Messenger 수동 업데이트
echo.
echo  메신저가 실행 중이면 자동으로 종료한 뒤 최신 파일로 덮어씁니다.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manual-hotfix-update.ps1" -ForceKill
echo.
pause
