@echo off
setlocal
cd /d "%~dp0"

set "RECOVERY=%CD%\scripts\recover-portable-operation.ps1"
if exist "%RECOVERY%" (
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%RECOVERY%" -ProjectRoot "%CD%"
  if errorlevel 1 (
    echo Xing Cang Jia detected an incomplete update or migration that could not be recovered safely.
    echo Please keep this directory intact and check .updates\operation-result.json.
    pause
    exit /b 1
  )
)

set "ELECTRON=%CD%\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo Xing Cang Jia portable runtime is incomplete.
  echo Missing: node_modules\electron\dist\electron.exe
  pause
  exit /b 1
)

start "Xing Cang Jia" "%ELECTRON%" "%CD%"
exit /b 0
