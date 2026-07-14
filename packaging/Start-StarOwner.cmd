@echo off
setlocal
cd /d "%~dp0"

set "ELECTRON=%CD%\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo Xing Cang Jia portable runtime is incomplete.
  echo Missing: node_modules\electron\dist\electron.exe
  pause
  exit /b 1
)

start "Xing Cang Jia" "%ELECTRON%" "%CD%"
exit /b 0
