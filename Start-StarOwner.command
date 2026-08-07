#!/bin/bash
# 星藏家 macOS 启动脚本（双击运行；关闭本终端不影响应用）
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_ROOT" || exit 1

# 已在运行则提示并退出（避免双开）
if curl -s --max-time 2 http://127.0.0.1:17391/api/manifest >/dev/null 2>&1; then
  echo "星藏家已在运行。如果窗口没显示，请在 Dock（程序坞）中查找。"
  sleep 2
  exit 0
fi

echo "正在启动星藏家…"
echo "日志：/tmp/star-owner-app.log"
nohup npm start > /tmp/star-owner-app.log 2>&1 &
sleep 3
if curl -s --max-time 2 http://127.0.0.1:17391/api/manifest >/dev/null 2>&1; then
  echo "启动成功 ✅（窗口已弹出）"
else
  echo "启动中…如 10 秒内无窗口，请查看日志：/tmp/star-owner-app.log"
fi
