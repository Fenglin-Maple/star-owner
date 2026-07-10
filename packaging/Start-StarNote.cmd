@echo off
setlocal
cd /d "%~dp0"

set "ELECTRON=%CD%\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo Star Note portable runtime is incomplete.
  echo Missing: node_modules\electron\dist\electron.exe
  pause
  exit /b 1
)

start "Star Note BiliNote" "%ELECTRON%" "%CD%"
exit /b 0
