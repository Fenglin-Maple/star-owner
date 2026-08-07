# macOS 适配记录（MLX Whisper ASR 替换）

> 状态：进行中 · 更新于 2026-08-05 · 目标平台：Apple Silicon (M4) · 基线版本：1.5.0

## 目标

原项目 ASR 依赖 faster-whisper / CTranslate2，GPU 推理只支持 NVIDIA CUDA。
macOS（Apple Silicon）上无 CUDA，故将 ASR 推理后端替换为 **MLX Whisper**（Apple 原生，Metal GPU 加速）。

## 总体设计

**双平台分支**：`darwin + arm64` 走 MLX，其余平台（Windows 等）保持 faster-whisper 原逻辑不变。
所有对外契约（CLI 参数、stdio JSON 行协议、srt/txt/json 产物格式、health 字段）保持不变，JS 侧只做平台感知的最小改动。

```
Node 侧 AsrService ──spawn──▶ tools/faster-whisper-service.py ──▶ MLX (darwin) / faster-whisper (win)
                                    │ 产物：transcript.srt / asr-transcript.txt / asr-result.json
```

## 运行时环境（项目内，不碰系统）

| 组件 | 位置 | 说明 |
|---|---|---|
| Python 3.12.12 | `runtime/python/cpython-3.12.12-macos-aarch64-none/` | uv 安装，自带 bin/python |
| venv | `runtime/faster-whisper/` | uv venv，mlx-whisper / yt-dlp / imageio-ffmpeg / huggingface_hub |
| ASR 模型 | `runtime/models/<id>/` | HF `mlx-community/whisper-large-v3-turbo` 等 |

## 已改动文件

| 文件 | 改动 | 角色 |
|---|---|---|
| `tools/faster-whisper-cli.py` | 双平台重写：darwin 走 `mlx_whisper.transcribe`（含 word_timestamps → 句子级分段复用原逻辑），模型下载改 `huggingface_hub.snapshot_download`（mlx-community 仓库）；health 输出新增 `mlxAvailable` | Hermes 初始实现 |
| `tools/faster-whisper-service.py` | 双平台：darwin 用 `mlx_whisper.load_model` 常驻加载，transcribe 适配 dict 返回（duration 用 load_audio 计算，languageProbability 无则 1.0） | Hermes 初始实现 |
| `src/core/child-process-io.js` | 新增导出 `findVenvSitePackages(venv)`：win32 → Lib/site-packages，POSIX → 扫描 lib/python*/；`projectRuntimeEnvironment` 使用之（修掉硬编码 lib/python3） | Hermes 初始实现 |
| `src/core/asr-service.js` | [待 builder] findRuntimePython 非 win32 优先 venv python；serviceEnvironment 用 findVenvSitePackages | Codex builder |
| `src/core/hardware-capabilities.js` | [待 builder] darwin 分支：mlxAvailable → gpuSupported；cpuArchitectureSupported darwin 为真；preferredMode='mlx' | Codex builder |
| `src/core/dependency-manager.js` | [待 builder] definitions() 平台化：darwin 不查 python.exe/msvcp140.dll，probes 指向 venv 结构；模型 probes 兼容 weights.npz/*.safetensors | Codex builder |
| `src/core/tool-runner.js` | [待 builder] gpuAsr device 在 darwin 用 'mlx'（ASR_GPU_DEVICE 常量），computeType 随之 | Codex builder |

## 模型清单（MLX 版，HuggingFace）

- `mlx-community/whisper-large-v3-turbo`（默认，约 1.6GB）
- `mlx-community/whisper-small-mlx`（可选，约 150MB）
- `mlx-community/whisper-medium-mlx`（保留映射，UI 不展示）

## 验证步骤

1. [x] venv 装包完成，`import mlx_whisper` + Metal 设备可用（`Device(gpu, 0)`）
2. [x] 模型下载完成，`runtime/models/large-v3-turbo/` 含 config.json + weights.safetensors（1.5G）
3. [x] `tools/faster-whisper-cli.py --health` 输出 mlxAvailable: true
4. [x] CLI 模式真实语音转录：14.3s 中文 → 5.6s（含模型加载）/ 7 句 SRT 时间轴正确，产物三件套正常
5. [x] Service 模式（stdio JSON 协议）：READY → transcribe ok=true → shutdown 正常
6. [ ] `npm start` 应用启动，任务总览 → 单视频总结全流程
7. [ ] OpenCode 独立复核全部改动（Windows 行为未破坏）

## MLX 0.4.x 已知差异（已适配）

| 差异 | 影响 | 处理 |
|---|---|---|
| `mlx_whisper.load_audio` / `load_model` 在子模块 | API 不兼容 | 用 `mlx_whisper.audio.load_audio`；service 不预加载模型 |
| `mlx.__version__` 不存在（0.32） | health 崩溃 | 改用 `importlib.metadata.version('mlx')` |
| beam_size 传任何值都触发未实现的 beam search | 解码报错 | 不传 beam_size（走 GreedyDecoder） |
| 输出不含标点 token | 句子切分失效、文本无标点 | segment 边界即句子粒度（时间戳驱动），words 置空直接采用段边界；无标点为引擎行为，列为已知限制 |
| 模型无缓存，每次 transcribe 重新加载（约 3s） | 每次请求多 3s | 接受（长视频推理占大头）；后续可加 lru_cache 包一层 |
| DecodingOptions 不支持 repetition_penalty / no_repeat_ngram_size / VAD | 防幻觉参数缺失 | 跳过；用 hallucination_silence_threshold 兜底 |
| mlx_whisper.audio.load_audio 硬编码 subprocess 'ffmpeg'，应用内 PATH 重建后找不到（imageio 二进制名带架构后缀） | `[Errno 2] No such file or directory: 'ffmpeg'` | 在 `runtime/faster-whisper/bin/ffmpeg` 建 symlink 指向 imageio_ffmpeg 二进制（venv/bin 本就在应用 PATH 里） |

## 原项目 bug 修复记录

| bug | 现象 | 修复 |
|---|---|---|
| tool-runner.js ASR 路径 `let diskError` 声明在 try 块内、catch 块引用（块级作用域不可见） | 任务失败时抛 `diskError is not defined` ReferenceError，掩盖真实错误 | 声明移到 try 外（win32 同样受益） |

## 边界与暂缓项

- GitHub 文档共享依赖内置 Portable Git（Windows 打包物 `runtime/git/cmd/git.exe`），macOS 暂不可用（应用会优雅降级），后续补 mac 版 git 运行时与 osxkeychain 凭据。
- 应用内更新（PowerShell 恢复脚本）仅 Windows，mac 暂不支持自更新。
- MLX 无 faster-whisper 的 VAD 参数；若长视频静音段产生幻觉文本，后续可加 mlx-whisper 的 VAD 支持或 hallucination_silence_threshold 等价处理。
- 服务模式（service.py）下 MLX 无法逐段流式进度，进度直接跳到完成（不影响产物）。

## 复核与二阶段修复记录

OpenCode 独立复核结论：Python 侧 + 硬件检测质量高、win32 保真（A 组 7/10），但衔接层未适配。三处必修：

| 问题 | 级别 | 修复方案 | 状态 |
|---|---|---|---|
| tool-runner 调度层 cuda 独占：lane 门控/gpuGate/ensureSelectedAsr/syncHardwareGpuState 全按 nvidia 判断，mac 上 GPU 通道永不启用且被显式阻断 | 高 | darwin 上把 'cuda' 配置语义映射为 MLX 通道（mlxAvailable 门控），配置枚举不变 | Codex builder 进行中 |
| internal-agent-manager:424 在 darwin 默认配置下抛『未检测到 NVIDIA/CUDA』拦截单视频主流程 | 高 | darwin 上 mlxAvailable 时放行，文案平台化 | Codex builder 进行中 |
| tools/video-tool.js 硬编码 `Scripts/python.exe`/`Lib/site-packages`，mac 上 ffmpeg/yt-dlp/faster-whisper 全解析为空，媒体链路在 ASR 前断裂 | 高 | 平台化解析（bin/python + lib/python*/ 扫描）+ POSIX 系统 PATH 回退 | Codex builder 进行中 |
| darwin 依赖面板失效（packageHealth 要求 archive 安装清单，本地搭建无清单 → 恒显示未安装、模型下拉禁用） | 中 | darwin 分支：probes 全过即 available（local-config 模式） | Codex builder 进行中 |

低危项（随集成测试观察，暂缓）：A8 win32 缺最终进度事件、A9 txt 空行过滤、A10 diagnostics schema 键名变更（无 JS 消费者）、B5 失败诊断错位（device='mlx' 归 GPU 归因，误导排障）、B12 nvidia-smi 每 60s 噪音（darwin 已跳过）、C3 rag-assistant cmd.exe 工具、C4-C8 各降级路径。
