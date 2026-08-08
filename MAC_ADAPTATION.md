# macOS 适配记录（MLX Whisper ASR 替换）

> 状态：已完成（PR #3 已合并 mac 分支，review 建议迭代中） · 更新于 2026-08-07 · 目标平台：Apple Silicon (M4) · 基线版本：1.6.2

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
| Python 3.12.12 | `runtime/python/cpython-3.12.12-macos-aarch64-none/` | uv 引导安装（优先 PATH 中已有 uv；缺失时脚本自动下载固定版本 0.12.3 到 `runtime/uv/`，SHA-256 校验，不写系统目录），自带 bin/python |
| venv | `runtime/faster-whisper/` | uv venv，mlx-whisper / yt-dlp / imageio-ffmpeg / huggingface_hub |
| ASR 模型 | `runtime/models/<id>/` | HF `mlx-community/whisper-large-v3-turbo` 等 |
| 安装清单 | `runtime/.dependency-manifests/<id>.json` | `npm run manifest:mac` 生成，含 SHA-256 |

## 改动清单（22 个文件）

### Python 侧

| 文件 | 改动 |
|---|---|
| `tools/faster-whisper-cli.py` | 双平台重写：darwin 走 `mlx_whisper.transcribe`（word_timestamps → 句子级分段复用原逻辑），模型下载改 `huggingface_hub.snapshot_download`（mlx-community 仓库）；health 输出新增 `mlxAvailable` |
| `tools/faster-whisper-service.py` | 双平台：stdio JSON 协议不变；darwin 每次 transcribe 顶层调用 `mlx_whisper.transcribe`（模型无缓存，不预加载） |

### JS 核心

| 文件 | 改动 |
|---|---|
| `src/core/child-process-io.js` | 新增导出 `findVenvSitePackages(venv)`：win32 → Lib/site-packages，POSIX → 扫描 lib/python*/；`projectRuntimeEnvironment` 使用之（修掉硬编码 lib/python3） |
| `src/core/asr-service.js` | `findRuntimePython` 非 win32 优先 venv python；serviceEnvironment 用 findVenvSitePackages |
| `src/core/hardware-capabilities.js` | darwin 分支：mlxAvailable → gpuSupported；cpuArchitectureSupported darwin 为真；preferredMode='mlx'；文案平台化 |
| `src/core/tool-runner.js` | 调度层 MLX 通道：lane 门控/gpuGate/syncHardwareGpuState/refreshGpuState 平台化（darwin 用 mlxAvailable 替代 nvidia 判定，配置枚举不变）；修复原项目 diskError 作用域 bug |
| `src/core/internal-agent-manager.js` | 单视频闸门 darwin 放行（mlxAvailable）；新增「内容审核拒绝自动跳过」分支（任务 enabled=false 不再自动派发、emit content-rejected 事件、会话不阻塞） |
| `src/core/dependency-manager.js` | darwin definitions 平台化（probes 指向 venv/MLX 模型，assetName 置空）；packageHealth darwin 三重校验（probes + manifest + SHA-256 重算，符合 SECURITY.md L41）；562 行 assetPattern 空串守卫修复 |
| `src/main.js` | window-all-closed 关窗口即完整退出（darwin）；sendRuntime/safeSend 统一 webContents 销毁保护（退出无崩溃弹窗）；rag:provider-test IPC；content-rejected 系统通知 |
| `src/preload.js` | 暴露 ragTestProvider |

### 渲染进程

| 文件 | 改动 |
|---|---|
| `src/renderer/ai.js` | 模型配置「测试连接」按钮 + 「手动添加自定义模型」（拉取接口不可用时的兜底）；content-rejected 红色 toast 通知 |
| `src/renderer/index.html` / `styles.css` / `app.js` | 对应 UI 元素与样式（含 macOS 窗口红绿灯 titleBarStyle hiddenInset） |

### 工具与脚本

| 文件 | 改动 |
|---|---|
| `tools/video-tool.js` | 路径平台化（resolveWhisperPython / resolveImageIoBinaries）+ 内置工具缺失即中文提示（MISSING_COMMAND_HINTS，按平台引导运行 setup:mac / setup:asr）；不再回退系统 PATH——明确不使用全局 FFmpeg、全局 Python 与全局 yt-dlp |
| `scripts/generate-mac-manifest.js` | 生成 darwin 依赖安装清单（SHA-256），`npm run manifest:mac` | 实现 |
| `scripts/setup-macos-runtime.sh` | Apple Silicon 完整部署脚本（uv 自动引导 → Python/venv → mlx 安装 → 模型下载 → ffmpeg symlink 创建验证 → manifest 生成），`npm run setup:mac` | 实现 |
| `Start-StarOwner.command` / `Start-StarOwner.cmd` | macOS/Windows 双击启动器：直接调用项目自带 Electron（不依赖全局 npm）、从 `runtime/.api-port` 读取实际端口做防双开与成功判断 | 实现 |
| `MAC_ADAPTATION.md` | 本文档 | 文档 |

## 模型清单（MLX 版，HuggingFace）

模型名 → 仓库映射见 `tools/faster-whisper-cli.py` 的 `MLX_MODEL_REPOS`（未知模型名回退 `mlx-community/whisper-<name>`）：

- `small` → `mlx-community/whisper-small-mlx`（可选，约 150MB）
- `medium` → `mlx-community/whisper-medium-mlx`（保留映射，UI 不展示）
- `turbo` / `large-v3-turbo` → `mlx-community/whisper-large-v3-turbo`（默认，约 1.6GB）

## 验证结果

| 项 | 结果 |
|---|---|
| venv 装包 + Metal 设备可用（`Device(gpu, 0)`） | ✅ |
| 模型下载（config.json + weights.safetensors 1.5G） | ✅ |
| `cli.py --health` 输出 mlxAvailable: true | ✅ |
| CLI 真实语音转录：14.3s 中文 → 5.6s（含加载）/ 7 句 SRT 正确 | ✅ |
| Service 模式：READY → transcribe ok=true → shutdown 正常 | ✅ |
| Python 侧 ad-hoc 全量（py_compile/health/CLI/Service 协议） | ✅ 8/8 |
| JS 侧验收（调度层/依赖/平台化契约） | ✅ 9/9 |
| OpenCode 独立复核两轮（win32 保真 A 组 7/10 + 二阶段 4 项） | ✅ |
| manifest 校验（正常/篡改/删除/恢复） | ✅ 10/10 |
| 集成：npm start 启动 + 单视频总结 + 收藏夹工作流真实跑通 | ✅ |
| 退出行为（关窗口干净退出、无崩溃弹窗） | ✅ |

## MLX 0.4.x 已知差异（已适配）

| 差异 | 影响 | 处理 |
|---|---|---|
| `mlx_whisper.load_audio` / `load_model` 在子模块 | API 不兼容 | 用 `mlx_whisper.audio.load_audio`；service 不预加载模型 |
| `mlx.__version__` 不存在（0.32） | health 崩溃 | 改用 `importlib.metadata.version('mlx')` |
| beam_size 传任何值都触发未实现的 beam search | 解码报错 | 不传 beam_size（走 GreedyDecoder） |
| 输出不含标点 token | 句子切分失效、文本无标点 | segment 边界即句子粒度（时间戳驱动），words 置空直接采用段边界；无标点为引擎行为，列为已知限制 |
| 模型无缓存，每次 transcribe 重新加载（约 3s） | 每次请求多 3s | 接受（长视频推理占大头）；后续可加 lru_cache 包一层 |
| DecodingOptions 不支持 repetition_penalty / no_repeat_ngram_size / VAD | 防幻觉参数缺失 | 跳过；用 hallucination_silence_threshold 兜底 |
| mlx_whisper.audio.load_audio 硬编码 subprocess 'ffmpeg'，应用内 PATH 重建后找不到 | `[Errno 2] No such file or directory: 'ffmpeg'` | 在 `runtime/faster-whisper/bin/ffmpeg` 建 symlink 指向 imageio_ffmpeg 二进制（venv/bin 本就在应用 PATH 里） |

## 原项目 bug 修复记录

| bug | 现象 | 修复 |
|---|---|---|
| tool-runner.js ASR 路径 `let diskError` 声明在 try 块内、catch 块引用（块级作用域不可见） | 任务失败时抛 `diskError is not defined` ReferenceError，掩盖真实错误 | 声明移到 try 外（win32 同样受益） |
| 退出时 ToolRunner 定时器向已销毁的 webContents 发送事件 | 关闭窗口后弹出「Object has been destroyed」未捕获异常 | main.js 统一 safeSend（isDestroyed + try/catch 保护），所有 webContents.send 走安全通道 |

## Review 迭代记录（PR #3 合并后，按原作者建议完善）

| 作者建议 | 处理 | 状态 |
|---|---|---|
| 补齐 macOS 全新部署流程 | 新增 `scripts/setup-macos-runtime.sh`（uv 自动引导：优先 PATH 中已有 uv，缺失时自动下载固定版本 0.12.3 到 `runtime/uv/` 并校验 SHA-256，不要求全局安装 → Python/venv → mlx 安装 → 模型下载 → ffmpeg symlink → manifest 生成，可重复执行、逐步幂等）；darwin 下载按钮加 installHint 提示 | ✅ |
| FFmpeg 链接脚本化 | 安装脚本内置 symlink 创建 + 验证（相对路径链接，项目移动不失效），不依赖全局 FFmpeg | ✅ |
| 统一 CPU ASR 与 MLX 语义 | 实测 MLX 可强制 CPU（`mx.set_default_device(mx.cpu)` + fp16）；`--device cpu` 真实 CPU 路径已实现（cli/service 双模式验证）；平台判断统一 darwin+arm64（Intel Mac 走 faster-whisper CPU 语义） | ✅ |
| 平台模型探针 | tool-runner 抽象 `detectModelFiles`（model.bin / weights.npz / .safetensors 分片），模型就绪检查与切换逻辑接入 | ✅ |
| 依赖健康检查优化 | pyc 排除 + mtime/size 指纹缓存（实测 754ms → 0.3ms，提速 >2500×）；manifest 变更纳入指纹 | ✅ |
| 本地媒体工具平台化 | child-process-io 新增 `resolveRuntimeBinaries` 跨平台 helper，local-media-runtime 接入 | ✅ |
| video-tool 系统 PATH 回退改提示 | 缺失即输出中文明确提示（引导运行 setup:mac），不再静默回退 | ✅ |
| 模型下载 staging | cli.py 下载改 staging 目录 + 完整文件清单校验 + 完成标记 + 原子改名 + 中断清理 + 幂等跳过（真实网络端到端验证） | ✅ |
| 启动器改项目自带 Electron | .command/.cmd 直接调用 `node_modules/electron/dist/Electron`（不依赖全局 npm/curl）；api-server 实际端口落盘 `runtime/.api-port`，启动器读取做防双开与成功判断 | ✅ |
| sendBootstrap/sendRuntime 统一 safeSend | 全部收敛（文件内裸 webContents.send 仅剩 safeSend 内部 1 处） | ✅ |
| 供应商测试用保存温度 + 响应结构验证 | testProvider 用 provider.temperature（默认 0.2），校验 choices/message/content 结构 | ✅ |
| 审核错误优先结构化错误码 | providerHttpError 解析供应商错误码（error.code/type），`isContentRejectedError(value, supplierCode)` 码优先、message 正则兜底（原签名兼容） | ✅ |

## 边界与暂缓项

- GitHub 文档共享依赖内置 Portable Git（Windows 打包物 `runtime/git/cmd/git.exe`），macOS 暂不可用（应用会优雅降级），后续补 mac 版 git 运行时与 osxkeychain 凭据。
- 应用内更新（PowerShell 恢复脚本）仅 Windows，mac 暂不支持自更新。
- MLX 无 faster-whisper 的 VAD 参数；若长视频静音段产生幻觉文本，后续可加 VAD 支持。
- 服务模式（service.py）下 MLX 无法逐段流式进度，进度直接跳到完成（不影响产物）。
- 低危观察项（随集成测试观察，暂缓）：A8 win32 缺最终进度事件、A9 txt 空行过滤、A10 diagnostics schema 键名变更（无 JS 消费者）、B5 失败诊断错位（device='mlx' 归 GPU 归因）、C3 rag-assistant cmd.exe 工具、C4-C8 各降级路径。
