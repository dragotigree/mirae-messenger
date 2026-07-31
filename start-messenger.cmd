@echo off
chcp 65001 >nul
set "ROOT=%~dp0"
set "ELECTRON=%ROOT%node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo electron.exe 를 찾을 수 없습니다. node_modules 설치 후 다시 시도하세요.
  pause
  exit /b 1
)
start "" "%ELECTRON%" "%ROOT%"
exit /b 0
