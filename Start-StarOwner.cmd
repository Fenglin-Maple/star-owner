@echo off
setlocal
rem ============================================================
rem  星藏家 macOS/Windows 通用源码启动器（Windows 版）
rem  双击运行；等价于在项目根目录执行 npm start
rem ============================================================
cd /d "%~dp0"

rem 防双开：API 端口已在监听说明应用正在运行
curl -s -m 2 http://127.0.0.1:17391/api/manifest >nul 2>&1
if %errorlevel%==0 (
  echo 星藏家已在运行。如果窗口没显示，请在任务栏/系统托盘中查找。
  pause
  exit /b 0
)

echo 正在启动星藏家...
echo 提示：关闭本窗口即退出应用。
npm start
exit /b %errorlevel%