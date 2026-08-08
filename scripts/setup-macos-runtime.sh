#!/usr/bin/env bash
# ============================================================================
# setup-macos-runtime.sh —— macOS（Apple Silicon）星藏家本地运行时安装脚本
#
# macOS 上星藏家采用「本地配置模式」：不通过 GitHub Release 下载依赖包，而是
# 用 uv 在项目内安装 Python 3.12 + venv（mlx-whisper / yt-dlp / imageio-ffmpeg /
# huggingface_hub），并从 HuggingFace mlx-community 仓库下载模型。本脚本把整套
# 流程固化为可重复执行的一条命令：
#
#   bash scripts/setup-macos-runtime.sh                          # 默认 large-v3-turbo
#   bash scripts/setup-macos-runtime.sh --model small            # 空格形式，改用 small 模型
#   bash scripts/setup-macos-runtime.sh --model=small            # 等号形式，等价
#   bash scripts/setup-macos-runtime.sh --skip-models            # 跳过模型下载
#
# uv 引导策略：优先使用 PATH 中已有的 uv；若缺失，自动下载固定版本（默认
# 0.12.3，可用环境变量 UV_VERSION 覆盖）到项目 runtime/uv/ 下，校验 SHA-256
# 后再执行——不写入任何系统目录、不要求用户全局安装。uv 的 Python 安装目录
# （--install-dir runtime/python/）与缓存目录（UV_CACHE_DIR=runtime/.uv-cache）
# 均显式限制在项目内。
#
# 依赖：node（生成依赖安装清单）、curl（引导 uv 时下载用，macOS 自带）。
# 重复执行安全：各步骤幂等（已存在的 venv / 模型 / 软链接会跳过或复用）。
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="$ROOT/runtime"
VENV="$RUNTIME/faster-whisper"
VENV_BIN="$VENV/bin"
MODELS_DIR="$RUNTIME/models"

# ---- 固定版本常量 ----------------------------------------------------------
# uv 固定版本（默认 0.12.3，可用环境变量 UV_VERSION 覆盖）。
# 资产名以 0.12.3 release 实测为准：uv-aarch64-apple-darwin.tar.gz（不带版本前缀）。
UV_VERSION="${UV_VERSION:-0.12.3}"
UV_SHA256_0_12_3="546f7f8a6c70ff13a3a9d2bc958db3427298cebf3e0cb756f9177133b7068843"
UV_RELEASE_URL="https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-apple-darwin.tar.gz"
UV_INSTALL_DIR="$RUNTIME/uv/uv-${UV_VERSION}"
UV_ASSET_NAME="uv-aarch64-apple-darwin.tar.gz"

# uv 缓存目录显式限制在项目内（Python 解释器下载缓存 + pip 包缓存）
export UV_CACHE_DIR="$RUNTIME/.uv-cache"

# 默认模型与 HuggingFace mlx-community 仓库的显式映射（与 tools/faster-whisper-cli.py
# 的 MLX_MODEL_REPOS 保持一致：small → whisper-small-mlx，large-v3-turbo → whisper-large-v3-turbo）
MODEL="large-v3-turbo"
SKIP_MODELS="0"

# ---- 参数解析：--model 支持空格（--model small）与等号（--model=small）两种形式 ----
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-models) SKIP_MODELS="1"; shift ;;
    --model=*) MODEL="${1#--model=}"; shift ;;
    --model)
      if [[ $# -lt 2 ]]; then
        echo "错误：--model 需要一个参数（small | large-v3-turbo），例如 --model small" >&2
        exit 1
      fi
      MODEL="$2"
      shift 2
      ;;
    *)
      echo "未知参数：$1（支持 --model <id>、--model=<id>、--skip-models）" >&2
      exit 1
      ;;
  esac
done

# 模型 ID 白名单校验 + 仓库/revision 映射（显式映射，不做字符串拼接，防注入且与 Python 侧一致。
# revision 固定：2026-08-08 经 HuggingFace API 实测的 main 分支 sha，与本地已下载模型的缓存
# tree 哈希一致，保证重复安装内容可复现。注意用 case 而非关联数组——macOS 自带 bash 3.2 不支持）
MODEL_REPO=""
MODEL_REVISION=""
case "$MODEL" in
  small)
    MODEL_REPO="mlx-community/whisper-small-mlx"
    MODEL_REVISION="45f3915923c7a79a5a5b5a7d909d39aeb0e5630e"
    ;;
  large-v3-turbo)
    MODEL_REPO="mlx-community/whisper-large-v3-turbo"
    MODEL_REVISION="a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb"
    ;;
  *)
    echo "不支持的模型：${MODEL}（支持 small、large-v3-turbo）" >&2
    exit 1
    ;;
esac

step() { printf '\n\033[1;36m[%s/%s] %s\033[0m\n' "$1" "$2" "$3"; }
ok() { printf '\033[32m✓ %s\033[0m\n' "$1"; }
info() { printf '\033[33m%s\033[0m\n' "$1"; }

# ---- resolve_uv：优先 PATH 中的 uv；缺失时下载固定版本到项目 runtime/uv/ ----------
# 全局变量 UV_CMD：后续所有 uv 调用统一使用 "$UV_CMD"（可能是系统 uv，也可能是项目内 uv）
resolve_uv() {
  # 1) PATH 中已有 uv：直接使用，不重复下载
  if command -v uv >/dev/null 2>&1; then
    ok "使用 PATH 中的 uv：$(uv --version)"
    UV_CMD="uv"
    return 0
  fi

  # 2) 项目内已下载过固定版本：直接复用（不重复下载、不重新校验）
  local existing
  existing="$(find "$UV_INSTALL_DIR" -maxdepth 3 -type f -name 'uv' -perm -111 2>/dev/null | head -n 1 || true)"
  if [[ -n "$existing" ]]; then
    # 注意 ${existing} 用花括号界定：bash 3.2 + set -u 下，裸 $existing 后紧跟全角字符（如（）
    # 会被误并入变量名导致 "unbound variable"（bash 3.2 多字节 locale 的已知解析问题）
    ok "复用项目内已下载的 uv：${existing}（$("$existing" --version)）"
    UV_CMD="$existing"
    return 0
  fi

  # 3) 下载固定版本到项目 runtime/uv/（不写入系统目录，不改用户配置）
  echo "未检测到系统 uv。将自动下载固定版本 uv ${UV_VERSION} 到项目目录（不写入系统目录）："
  echo "  来源：${UV_RELEASE_URL}"
  if [[ "$UV_VERSION" == "0.12.3" ]]; then
    echo "  校验：下载后比对 SHA-256 = ${UV_SHA256_0_12_3}"
  else
    info "注意：UV_VERSION=${UV_VERSION} 不是脚本内置 SHA-256 的 0.12.3，将跳过校验（仅固定版本校验）。"
  fi

  mkdir -p "$UV_INSTALL_DIR"
  local tarball="$UV_INSTALL_DIR/$UV_ASSET_NAME"
  curl -fL --retry 3 --connect-timeout 30 -o "$tarball" "$UV_RELEASE_URL"

  if [[ "$UV_VERSION" == "0.12.3" ]]; then
    local actual
    actual="$(shasum -a 256 "$tarball" | awk '{print $1}')"
    if [[ "$actual" != "$UV_SHA256_0_12_3" ]]; then
      echo "错误：uv 压缩包 SHA-256 校验失败，已中止安装！" >&2
      echo "  期望：${UV_SHA256_0_12_3}" >&2
      echo "  实际：${actual}" >&2
      echo "  请检查网络代理/镜像，或删除 ${tarball} 后重试。" >&2
      exit 1
    fi
    ok "uv 压缩包 SHA-256 校验通过"
  fi

  tar -xzf "$tarball" -C "$UV_INSTALL_DIR"
  rm -f "$tarball"
  local bin
  bin="$(find "$UV_INSTALL_DIR" -maxdepth 3 -type f -name 'uv' -perm -111 2>/dev/null | head -n 1 || true)"
  if [[ -z "$bin" ]]; then
    echo "错误：解压后未在 ${UV_INSTALL_DIR} 下找到 uv 可执行文件。" >&2
    exit 1
  fi
  UV_CMD="$bin"
  ok "项目内 uv 就绪：${UV_CMD}（$("$UV_CMD" --version)）"
}

echo "星藏家 macOS 本地运行时安装（项目根目录：${ROOT}）"
if [[ "$(uname -s)" != "Darwin" ]]; then
  info "警告：当前系统不是 macOS，MLX Whisper 依赖 Apple Silicon 生态，后续步骤可能失败。"
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  info "警告：当前 CPU 架构不是 arm64，MLX 仅支持 Apple Silicon（M 系列芯片）。"
fi

# ---- 步骤 1/8：检查 / 引导 uv --------------------------------------------------
step 1 8 "检查 / 引导 uv（优先 PATH，缺失则下载固定版本到 runtime/uv/）"
resolve_uv

# ---- 步骤 2/8：安装 Python 3.12（托管到 runtime/python/） ---------------------
step 2 8 "安装 Python 3.12（uv 托管到 runtime/python/）"
mkdir -p "$RUNTIME"
"$UV_CMD" python install 3.12 --install-dir "$RUNTIME/python"
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
  "$UV_CMD" venv "$VENV" --python "$PYTHON_BIN"
  ok "venv 创建完成：$VENV"
fi

# ---- 步骤 4/8：安装 mlx-whisper 等 Python 依赖（版本固定，可复现） --------------
step 4 8 "安装 mlx-whisper / yt-dlp / imageio-ffmpeg / huggingface_hub"
# PYTHONPATH 置空：避免用户环境变量干扰 venv 内解释器与包解析（幂等，可重复执行）。
# 版本为 2026-08-08 在本机 venv 内实测（pip freeze）的当前版本，固定后可复现。
env -u PYTHONPATH "$UV_CMD" pip install --python "$VENV_BIN/python" \
  "mlx-whisper==0.4.3" "yt-dlp==2026.7.4" "imageio-ffmpeg==0.6.0" "huggingface_hub==1.24.0"
ok "Python 依赖安装完成（版本已固定）"

# ---- 步骤 5/8：下载模型（--skip-models 可跳过） -------------------------------
if [[ "$SKIP_MODELS" == "1" ]]; then
  info "已跳过模型下载（--skip-models）。"
else
  step 5 8 "下载模型 ${MODEL_REPO}（revision ${MODEL_REVISION}）→ runtime/models/$MODEL"
  mkdir -p "$MODELS_DIR"
  env -u PYTHONPATH "$VENV_BIN/python" -c \
    "from huggingface_hub import snapshot_download; snapshot_download('$MODEL_REPO', revision='$MODEL_REVISION', local_dir='$MODELS_DIR/$MODEL')"
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
