#!/usr/bin/env bash
# ============================================================================
# setup-macos-runtime.sh —— macOS（Apple Silicon）星藏家本地运行时安装脚本
#
# macOS 上星藏家采用「本地配置模式」：不通过 GitHub Release 下载依赖包，而是
# 用 uv 在项目内安装 Python 3.12 + venv（mlx-whisper / yt-dlp / imageio-ffmpeg /
# huggingface_hub），并从 HuggingFace mlx-community 仓库下载模型。本脚本把整套
# 流程固化为可重复执行的一条命令：
#
#   bash scripts/setup-macos-runtime.sh                     # 默认 large-v3-turbo
#   bash scripts/setup-macos-runtime.sh --model small       # 改用 small 模型
#   bash scripts/setup-macos-runtime.sh --skip-models       # 跳过模型下载
#
# 依赖：uv（https://docs.astral.sh/uv/）、node（生成依赖安装清单）。
# 重复执行安全：各步骤幂等（已存在的 venv / 模型 / 软链接会跳过或复用）。
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="$ROOT/runtime"
VENV="$RUNTIME/faster-whisper"
VENV_BIN="$VENV/bin"
MODELS_DIR="$RUNTIME/models"

# 默认模型与 HuggingFace mlx-community/whisper-<model> 仓库对应（支持 small、large-v3-turbo）
MODEL="large-v3-turbo"
SKIP_MODELS="0"

for arg in "$@"; do
  case "$arg" in
    --skip-models) SKIP_MODELS="1" ;;
    --model=*) MODEL="${arg#--model=}" ;;
    --model)
      echo "用法：--model <id>（small | large-v3-turbo），例如 --model small" >&2
      exit 1
      ;;
    *)
      echo "未知参数：$arg（支持 --model <id>、--skip-models）" >&2
      exit 1
      ;;
  esac
done

# 模型 ID 白名单校验（会拼进 HuggingFace 仓库名，必须防注入）
case "$MODEL" in
  small | large-v3-turbo) ;;
  *)
    echo "不支持的模型：$MODEL（支持 small、large-v3-turbo）" >&2
    exit 1
    ;;
esac

step() { printf '\n\033[1;36m[%s/%s] %s\033[0m\n' "$1" "$2" "$3"; }
ok() { printf '\033[32m✓ %s\033[0m\n' "$1"; }
info() { printf '\033[33m%s\033[0m\n' "$1"; }

echo "星藏家 macOS 本地运行时安装（项目根目录：$ROOT）"
if [[ "$(uname -s)" != "Darwin" ]]; then
  info "警告：当前系统不是 macOS，MLX Whisper 依赖 Apple Silicon 生态，后续步骤可能失败。"
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  info "警告：当前 CPU 架构不是 arm64，MLX 仅支持 Apple Silicon（M 系列芯片）。"
fi

# ---- 步骤 1/8：检查 uv -------------------------------------------------------
step 1 8 "检查 uv（Python 运行时与包管理器）"
if ! command -v uv >/dev/null 2>&1; then
  echo "未检测到 uv。请先安装（任选其一）：" >&2
  echo "  curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  echo "  brew install uv" >&2
  echo "文档：https://docs.astral.sh/uv/" >&2
  exit 1
fi
ok "uv 已就绪：$(uv --version)"

# ---- 步骤 2/8：安装 Python 3.12（托管到 runtime/python/） ---------------------
step 2 8 "安装 Python 3.12（uv 托管到 runtime/python/）"
mkdir -p "$RUNTIME"
uv python install 3.12 --install-dir "$RUNTIME/python"
PYTHON_BIN="$(find "$RUNTIME/python" -maxdepth 4 -type f -name 'python3.12' 2>/dev/null | head -n 1 || true)"
if [[ -z "$PYTHON_BIN" ]]; then
  echo "错误：未在 runtime/python/ 下找到 python3.12 可执行文件，请检查上一步输出。" >&2
  exit 1
fi
ok "Python：$PYTHON_BIN"

# ---- 步骤 3/8：创建虚拟环境（已存在则跳过） ----------------------------------
step 3 8 "创建虚拟环境 runtime/faster-whisper"
if [[ -x "$VENV_BIN/python" ]]; then
  ok "venv 已存在，跳过创建：$VENV"
else
  uv venv "$VENV" --python "$PYTHON_BIN"
  ok "venv 创建完成：$VENV"
fi

# ---- 步骤 4/8：安装 mlx-whisper 等 Python 依赖 --------------------------------
step 4 8 "安装 mlx-whisper / yt-dlp / imageio-ffmpeg / huggingface_hub"
# PYTHONPATH 置空：避免用户环境变量干扰 venv 内解释器与包解析（幂等，可重复执行）
env -u PYTHONPATH uv pip install --python "$VENV_BIN/python" mlx-whisper yt-dlp imageio-ffmpeg huggingface_hub
ok "Python 依赖安装完成"

# ---- 步骤 5/8：下载模型（--skip-models 可跳过） -------------------------------
if [[ "$SKIP_MODELS" == "1" ]]; then
  info "已跳过模型下载（--skip-models）。"
else
  step 5 8 "下载模型 mlx-community/whisper-$MODEL → runtime/models/$MODEL"
  mkdir -p "$MODELS_DIR"
  env -u PYTHONPATH "$VENV_BIN/python" -c \
    "from huggingface_hub import snapshot_download; snapshot_download('mlx-community/whisper-$MODEL', local_dir='$MODELS_DIR/$MODEL')"
  ok "模型下载完成：$MODELS_DIR/$MODEL"
fi

# ---- 步骤 6/8：创建并验证 ffmpeg 软链接 ---------------------------------------
step 6 8 "创建 ffmpeg 软链接（imageio-ffmpeg 自带二进制 → venv/bin/ffmpeg）"
SITE_PACKAGES="$(find "$VENV/lib" -maxdepth 2 -type d -name 'site-packages' 2>/dev/null | head -n 1 || true)"
if [[ -z "$SITE_PACKAGES" ]]; then
  echo "错误：未找到 venv 的 site-packages，请检查步骤 4 是否成功。" >&2
  exit 1
fi
FFMPEG_SRC="$(find "$SITE_PACKAGES/imageio_ffmpeg/binaries" -maxdepth 1 -type f -name 'ffmpeg-macos-*' 2>/dev/null | head -n 1 || true)"
if [[ -z "$FFMPEG_SRC" ]]; then
  echo "错误：未在 imageio-ffmpeg 包内找到 ffmpeg-macos-* 二进制，请检查步骤 4。" >&2
  exit 1
fi
# 用相对路径建链（相对链接在项目整体移动后依然有效），由 venv python 计算相对关系
FFMPEG_LINK_TARGET="$(env -u PYTHONPATH "$VENV_BIN/python" -c "import os, sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))" "$FFMPEG_SRC" "$VENV_BIN")"
ln -sfn "$FFMPEG_LINK_TARGET" "$VENV_BIN/ffmpeg"
ok "软链接：$VENV_BIN/ffmpeg → $FFMPEG_LINK_TARGET"
# 验证：与应用运行时（projectRuntimeEnvironment）一致，把 venv/bin 前置到 PATH，
# 让 MLX Whisper 通过 subprocess 解析到项目内 ffmpeg 命令，无需用户全局安装。
if PATH="$VENV_BIN:$PATH" env -u PYTHONPATH "$VENV_BIN/python" -c \
  "import subprocess; subprocess.run(['ffmpeg', '-version'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)"; then
  ok "ffmpeg 验证通过（venv python 可调用 ffmpeg -version）"
else
  echo "错误：ffmpeg 软链接验证失败，MLX Whisper 将无法转码音频。" >&2
  exit 1
fi

# ---- 步骤 7/8：生成依赖安装清单 -----------------------------------------------
step 7 8 "生成依赖安装清单（runtime/.dependency-manifests/）"
if (cd "$ROOT" && node scripts/generate-mac-manifest.js); then
  ok "依赖清单生成完成"
else
  # 可选模型（如 small）未下载时脚本会以非 0 退出，属正常现象，不阻断安装
  info "注意：部分依赖包未生成清单——通常是未下载的可选模型，属正常；"
  info "需要时可用 bash scripts/setup-macos-runtime.sh --model small 补装后重跑 npm run manifest:mac。"
fi

# ---- 步骤 8/8：完成 -----------------------------------------------------------
step 8 8 "完成"
echo "安装完成，可双击启动星藏家。"
echo "其他命令："
echo "  补装其他模型  bash scripts/setup-macos-runtime.sh --model small"
echo "  重新生成清单  npm run manifest:mac"
