#!/bin/bash
# 星藏家 macOS 启动脚本（双击运行；关闭本终端不影响应用）
# 直接调用项目自带 Electron（不依赖全局 npm）；实际 API 端口从 runtime/.api-port 读取
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_ROOT" || exit 1

PORT_FILE="$PROJECT_ROOT/runtime/.api-port"
ELECTRON_BIN="$PROJECT_ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
LOG_FILE="/tmp/star-owner-app.log"

# 依赖检查：项目自带 Electron 不存在说明尚未安装依赖
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "未找到项目自带 Electron（$ELECTRON_BIN）。"
  echo "请先在项目根目录执行：npm install"
  sleep 3
  exit 1
fi

# 防双开：读取上次落盘的实际 API 端口，端口可连说明已在运行
if [ -f "$PORT_FILE" ]; then
  RUNNING_PORT="$(cat "$PORT_FILE" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$RUNNING_PORT" ] && curl -s -m 1 "http://127.0.0.1:${RUNNING_PORT}/api/manifest" >/dev/null 2>&1; then
    echo "星藏家已在运行（API 端口 ${RUNNING_PORT}）。如果窗口没显示，请在 Dock（程序坞）中查找。"
    sleep 2
    exit 0
  fi
  # 端口文件残留（上次异常退出），忽略并继续启动
  rm -f "$PORT_FILE"
fi

echo "正在启动星藏家…"
echo "日志：$LOG_FILE"
nohup "$ELECTRON_BIN" . > "$LOG_FILE" 2>&1 &

# 轮询等待端口落盘（最长 10 秒），落盘且端口可连即表示 API 服务已就绪
PORT=""
for _ in $(seq 1 10); do
  if [ -f "$PORT_FILE" ]; then
    PORT="$(cat "$PORT_FILE" 2>/dev/null | tr -d '[:space:]')"
    if [ -n "$PORT" ] && curl -s -m 1 "http://127.0.0.1:${PORT}/api/manifest" >/dev/null 2>&1; then
      break
    fi
  fi
  sleep 1
done

if [ -n "$PORT" ] && curl -s -m 1 "http://127.0.0.1:${PORT}/api/manifest" >/dev/null 2>&1; then
  echo "启动成功 ✅ 窗口已弹出（API 端口：${PORT}）"
else
  echo "启动中…如 10 秒内无窗口，请查看日志：$LOG_FILE"
fi
