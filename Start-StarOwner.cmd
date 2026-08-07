@echo off
setlocal enabledelayedexpansion
rem ============================================================
rem  星藏家源码启动器（Windows 版）
rem  双击运行；直接调用项目自带 Electron（不依赖全局 npm）
rem  实际 API 端口从 runtime\.api-port 读取
rem ============================================================
cd /d "%~dp0"

set "PORT_FILE=%CD%\runtime\.api-port"
set "ELECTRON_BIN=%CD%\node_modules\electron\dist\electron.exe"

rem 依赖检查：项目自带 Electron 不存在说明尚未安装依赖
if not exist "%ELECTRON_BIN%" (
  echo 未找到项目自带 Electron（%ELECTRON_BIN%）。
  echo 请先在项目根目录执行：npm install
  pause
  exit /b 1
)

rem 防双开：读取上次落盘的实际 API 端口，端口可连说明已在运行
if exist "%PORT_FILE%" (
  set /p RUNNING_PORT=<"%PORT_FILE%"
  if defined RUNNING_PORT (
    curl -s -m 1 "http://127.0.0.1:!RUNNING_PORT!/api/manifest" >nul 2>&1
    if not errorlevel 1 (
      echo 星藏家已在运行（API 端口 !RUNNING_PORT!）。如果窗口没显示，请在任务栏/系统托盘中查找。
      pause
      exit /b 0
    )
  )
  rem 端口文件残留（上次异常退出），忽略并继续启动
  del /q "%PORT_FILE%" >nul 2>&1
)

echo 正在启动星藏家...
echo 提示：关闭本窗口即退出应用。
"%ELECTRON_BIN%" .
exit /b %errorlevel%
